/**
 * "Why didn't you sell AVAX?"
 *
 * The command box could already route that question to an `explain` intent and
 * then had nothing to answer it with: the router's one-line acknowledgement
 * went through the same figure-stripping guard as every other reply, so any
 * answer worth reading was replaced by "The figures are on the screen next to
 * this."
 *
 * Correct guard, wrong place. The rule is not "no figures reach the user" — it
 * is "no figure the model typed reaches the user", and the narrative layer
 * already solved that: the model writes {{TOKEN}} placeholders and the server
 * substitutes real values afterwards. This reuses that machinery for questions
 * rather than reports, with the same guards and the same kind of fallback.
 *
 * Two things it deliberately does not do.
 *
 * It does not look at the market. The answer comes from the fact sheet the
 * verdict was actually made from, so asking an hour later gets the reason the
 * decision had, not a fresh opinion formed with information the decision never
 * saw. That distinction is the difference between an explanation and a second
 * guess.
 *
 * And it cannot change anything. There is no path from here to an allocation,
 * an order, or a stored decision.
 */

import type { ExplainFacts } from "../lib/api-contracts";
import { logDecision } from "./client";
import { findBareFigures, substitute, unnamedAssets } from "./narrative";
import { providerAvailable, structuredCall } from "./provider";
import { ExplainSchema } from "./schemas";

const SYSTEM = `You answer one question from a portfolio owner about a rebalancing decision that has already been made.

You are answering from the fact sheet the decision was made from. You are not
looking at the market now, and you must not speculate about what has happened
since or about what will happen next. If the facts do not contain the answer,
say that plainly.

You must NOT type any figure yourself. Every number, amount and percentage comes
from the placeholder list you are given. Write the placeholder exactly as shown,
including the braces, e.g. {{AVAX_DRIFT}}. The system substitutes real values
afterwards. If you type a figure directly, the whole answer is discarded.

Ticker symbols are words, not figures. Write BTC, ETH or AVAX directly. Never
use a placeholder where an asset's NAME belongs: {{AVAX_CURRENT}} is a
percentage, so "movement in {{AVAX_CURRENT}}" reads as "movement in 19.9%" and
is wrong. Whenever you quote an asset's figures, name that asset in the same
sentence.

You may write ordinary words for small counts ("both positions", "three legs").

Answer the question that was asked. If the owner asks about one position, the
answer is about that position — do not summarise the whole decision. If they ask
about a position that was not part of this decision, say so.

NOTHING HAS BEEN EXECUTED. The decision produced a *proposal*; the owner
approves it in Binance, and may not have. So never write that anything was
bought, sold, traded or rebalanced. Write about what the plan does: "the plan
sells SOL", "it proposes trimming SOL", "SOL was left out of the plan". Even if
the question is phrased as "why did you sell SOL", the answer is about a
proposed sale.

Voice: plain, direct, addressed to the owner. No hedging, no disclaimers, no
"as an AI". Two to four sentences. Do not offer to do anything: this surface
cannot trade, and approval happens in Binance.`;

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${n.toFixed(1)}%`;
const pp = (n: number) => `${n.toFixed(2)}pp`;
const trimQty = (n: number) => String(Number(n.toPrecision(6)));

/**
 * The substitution table, and by construction the entire set of figures an
 * answer is able to contain. Built here rather than shared with the narrative
 * layer because the two need different things: prose about a plan needs the
 * plan's notionals, an answer about a decision needs the signals that drove it.
 */
export function explainTokens(facts: ExplainFacts): Record<string, string> {
  const cb = facts.costBenefit;
  const tokens: Record<string, string> = {
    NAV: usd(facts.navUsd),
    TOTAL_DRIFT: pp(facts.totalDriftPp),
    EST_COST: usd(cb.estimatedCostUsd),
    DRIFT_REDUCTION: pp(cb.driftReductionPp),
    COST_PER_PP: usd(cb.costPerPpUsd),
    TRADE_COUNT: String(facts.trades.length),
    DAYS_SINCE: facts.daysSinceLastRebalance == null ? "never" : String(facts.daysSinceLastRebalance),
  };

  for (const r of facts.rows) {
    const s = r.symbol;
    tokens[`${s}_DRIFT`] = pp(r.driftPp);
    tokens[`${s}_BAND`] = pp(r.bandPp);
    tokens[`${s}_TARGET`] = pct(r.targetWeight * 100);
    tokens[`${s}_CURRENT`] = pct(r.currentWeight * 100);
    tokens[`${s}_DELTA`] = usd(Math.abs(r.deltaUsd));
    if (r.priceChange4hPct != null) tokens[`${s}_CHANGE_4H`] = pct(r.priceChange4hPct);
    if (r.priceChange24hPct != null) tokens[`${s}_CHANGE_24H`] = pct(r.priceChange24hPct);
    // Two decimals: it is a ratio around 1, and one place hides the difference
    // between 1.45 and 1.54 — which is the difference between firing and not.
    if (r.volRatio != null) tokens[`${s}_VOL_RATIO`] = r.volRatio.toFixed(2);
  }

  for (const t of facts.trades) {
    tokens[`${t.symbol}_NOTIONAL`] = usd(t.estNotionalUsd);
    tokens[`${t.symbol}_QTY`] = trimQty(t.qty);
  }

  return tokens;
}

/**
 * Prose claiming an order actually happened.
 *
 * Caught in the wild on the first live run: asked "why sell SOL?", the model
 * answered "You sold SOL because it crossed its tolerance band". Nothing had
 * been sold — the plan was on screen awaiting approval in Binance, and might
 * never get it. Every figure in the sentence was correct and the sentence was
 * still the one claim this product must never make.
 *
 * So the instruction in the prompt is backed by a check, the same way the
 * no-typed-figures rule is. A false positive costs fluency: the deterministic
 * answer is used instead, which is correct and duller. A false negative tells
 * an owner their money moved.
 */
export function claimsExecution(text: string): string[] {
  // Past-tense execution only. "the plan sells", "proposes trimming" and "SOL
  // trades thinly" are all fine and all stay fine.
  const re = /\b(sold|bought|traded|executed|rebalanced|liquidated|filled|purchased)\b/gi;
  return text.match(re) ?? [];
}

/**
 * How a position ended up, in the words the answer should use for it.
 *
 * Present tense about a plan, never past tense about a trade: nothing here has
 * executed, and a sentence saying it did contradicts the one boundary the whole
 * product is built on.
 */
function statusOf(r: ExplainFacts["rows"][number]): string {
  if (r.actedOn) return "is in the plan";
  if (r.declined) return "breached its band and was left out";
  if (r.outsideBand) return "is outside its band and not in the plan";
  return "is inside its band";
}

/**
 * The answer with no provider, or when the model's answer failed a guard.
 *
 * Not an apology: it states the verdict and what each position actually did,
 * which is most of what anyone asking "why" wants. It does not pretend to have
 * understood the question, because it did not read it.
 */
export function deterministicExplain(facts: ExplainFacts): string {
  const factor = facts.primaryFactor.replace(/_/g, " ");
  const head =
    facts.verdict === "HOLD"
      ? `Nothing was proposed, on ${factor}.`
      : `The verdict was ${facts.verdict}, on ${factor}.`;

  const notable = facts.rows.filter((r) => r.outsideBand || r.actedOn || r.declined);
  if (notable.length === 0) {
    return `${head} Total drift was ${pp(facts.totalDriftPp)}, with every position inside its band.`;
  }

  const lines = notable.map(
    (r) => `${r.symbol} ${statusOf(r)} (drift ${pp(r.driftPp)} against a ${pp(r.bandPp)} band)`,
  );
  return `${head} ${lines.join("; ")}. Total drift was ${pp(facts.totalDriftPp)}.`;
}

export async function explainDecision(question: string, facts: ExplainFacts): Promise<string> {
  const fallback = deterministicExplain(facts);
  if (!providerAvailable()) return fallback;

  const tokens = explainTokens(facts);

  const payload = {
    question,
    decision: {
      verdict: facts.verdict,
      primaryFactor: facts.primaryFactor,
      reasoning: facts.reasoning,
    },
    // Status, not figures. What each position *did* is a fact the model needs in
    // order to answer at all; what it was worth is a placeholder it can ask for.
    positions: facts.rows.map((r) => ({
      symbol: r.symbol,
      outsideBand: r.outsideBand,
      actedOn: r.actedOn,
      declined: r.declined,
    })),
    plan: facts.trades.map((t) => ({ side: t.side, symbol: t.symbol })),
    // Keys only — the same rule as the narrative layer. Handing over the values
    // would be handing over every real figure and then asking it not to type
    // one: material and opportunity in the same payload.
    availablePlaceholders: Object.keys(tokens).map((k) => `{{${k}}}`),
  };

  try {
    const res = await structuredCall({
      schema: ExplainSchema,
      schemaName: "explain",
      system: SYSTEM,
      facts: payload,
      temperature: 0.4,
      maxTokens: 900,
    });

    if (!res.ok) {
      logDecision("explain", "fallback", res.reason);
      return fallback;
    }

    const raw = res.value.answer;

    const executed = claimsExecution(raw);
    if (executed.length > 0) {
      logDecision("explain", "fallback", `claims an order happened: ${executed.join(", ")}`);
      return fallback;
    }

    const bare = findBareFigures(raw);
    if (bare.length > 0) {
      logDecision("explain", "fallback", `model typed figures directly: ${bare.join(", ")}`);
      return fallback;
    }

    const unnamed = unnamedAssets(
      raw,
      facts.rows.map((r) => r.symbol),
    );
    if (unnamed.length > 0) {
      logDecision("explain", "fallback", `figures quoted for unnamed assets: ${unnamed.join(", ")}`);
      return fallback;
    }

    const { out, unknown } = substitute(raw, tokens);
    if (unknown.length > 0) {
      logDecision("explain", "fallback", `unknown placeholders: ${unknown.join(", ")}`);
      return fallback;
    }
    if (!out.trim()) {
      logDecision("explain", "fallback", "empty after substitution");
      return fallback;
    }

    logDecision("explain", "ok");
    return out;
  } catch (err) {
    logDecision("explain", "fallback", err instanceof Error ? err.message : String(err));
    return fallback;
  }
}
