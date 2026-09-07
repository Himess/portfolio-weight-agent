/**
 * §7.4 — Narrative.
 *
 * "Every figure in the prose must be substituted from the deterministic layer —
 * pass numbers in as template values rather than letting the model retype them."
 *
 * That is enforced, not merely requested. The model writes prose containing
 * {{TOKEN}} placeholders; we substitute the real figures afterwards. Before
 * substituting we scan the raw output for any bare monetary, percentage, pp or
 * bps figure the model typed itself — if it typed one, the response is rejected
 * and we render a deterministic template instead.
 *
 * Bare small integers ("three positions") are allowed; the check targets exactly
 * the class of figure that could mislead about money.
 */

import type {
  CandidateTrade,
  OrderedTrade,
  Proposal,
  RebalanceContext,
  TimingDecision,
} from "../types";
import { logDecision } from "./client";
import { providerAvailable, structuredCall } from "./provider";
import { NarrativeSchema } from "./schemas";

const SYSTEM = `You write the two or three sentences a portfolio owner reads when the agent reports back.

You must NOT type any figure yourself. Every number, amount and percentage
comes from the placeholder list you are given. Write the placeholder exactly as
shown, including the braces, e.g. {{TOTAL_DRIFT}}. The system substitutes real
values afterwards. If you type a figure directly, the whole response is
discarded.

Ticker symbols are words, not figures. Write BTC, ETH or AVAX directly, exactly
like any other word. Never use a placeholder where an asset's NAME belongs:
{{AVAX_CURRENT}} is the number 19.9%, so "movement in {{AVAX_CURRENT}}" reads as
"movement in 19.9%" and is wrong. Write "movement in AVAX" instead. Whenever you
quote an asset's figures, name that asset in the same sentence.

You may write ordinary words for small counts ("both positions", "three legs").

Voice: plain, direct, addressed to the owner. No hedging, no disclaimers, no
"as an AI". Do not repeat the reasoning verbatim — you are summarizing the
outcome and what it means, not restating the analysis.

The product's whole point is that rebalancing means selling what went up and
buying what went down, which is psychologically hard. When the plan does that,
say so plainly — that is the insight the owner is paying for.

headline: one short clause, under 60 characters, no final period.
body: 2-3 sentences.`;

/** Build the substitution table. Every value here is deterministic. */
function buildTokens(
  ctx: RebalanceContext,
  timing: TimingDecision,
  trades: OrderedTrade[],
): Record<string, string> {
  const cb = ctx.costBenefit;
  const tokens: Record<string, string> = {
    NAV: usd(ctx.portfolio.navUsd),
    TOTAL_DRIFT: pp(ctx.portfolio.totalDriftPp),
    DRIFT_AFTER: pp(cb.totalDriftAfterPp),
    DRIFT_REDUCTION: pp(cb.driftReductionPp),
    EST_COST: usd(cb.estimatedCostUsd),
    COST_BPS: `${cb.costBps.toFixed(1)} bps`,
    COST_PER_PP: usd(cb.costPerPpUsd),
    TRADE_COUNT: String(trades.length),
    DAYS_SINCE: ctx.daysSinceLastRebalance == null ? "never" : String(ctx.daysSinceLastRebalance),
  };

  for (const row of ctx.portfolio.rows) {
    const s = row.symbol;
    tokens[`${s}_DRIFT`] = pp(row.driftPp);
    tokens[`${s}_TARGET`] = pct(row.targetWeight * 100);
    tokens[`${s}_CURRENT`] = pct(row.currentWeight * 100);
    tokens[`${s}_BAND`] = pp(row.bandPp);
    tokens[`${s}_DELTA`] = usd(Math.abs(row.deltaUsd));
  }

  for (const t of trades) {
    tokens[`${t.symbol}_NOTIONAL`] = usd(t.estNotionalUsd);
    tokens[`${t.symbol}_QTY`] = trimQty(t.qty);
  }

  for (const s of ctx.signals) {
    tokens[`${s.symbol}_CHANGE_24H`] = pct(s.priceChange24hPct);
    tokens[`${s.symbol}_CHANGE_4H`] = pct(s.priceChange4hPct);
  }

  return tokens;
}

/**
 * Assets whose figures are quoted without the asset ever being named.
 *
 * Caught in the wild: the model wrote "led by strong movement in
 * {{AVAX_CURRENT}}", which substitutes to "movement in 19.9%" — a placeholder
 * used where a name belonged. Nothing downstream noticed, because every token
 * resolved and no bare figure was typed; the sentence was simply nonsense.
 *
 * The invariant that catches it is also a product rule worth having: if the
 * prose quotes an asset's numbers, it has to say which asset they belong to.
 */
export function unnamedAssets(raw: string, symbols: string[]): string[] {
  const out: string[] = [];
  for (const symbol of symbols) {
    const quoted = new RegExp(String.raw`\{\{${symbol}_[A-Z0-9_]+\}\}`).test(raw);
    if (!quoted) continue;
    // The bare ticker, not the one inside a placeholder.
    const named = new RegExp(String.raw`(^|[^A-Z_{])${symbol}([^A-Z_}]|$)`).test(raw);
    if (!named) out.push(symbol);
  }
  return out;
}

/**
 * Sides the prose claims that the plan does not contain.
 *
 * Caught on the deployed site: the narrative read "Selling what went up allows
 * us to buy SOL and AVAX" while the plan held two SELL legs and no buys at all.
 * The root cause was elsewhere — two assets the active data source could not
 * price, so they showed as 0% weight and produced no candidate — but nothing
 * noticed the contradiction, and a proposal that describes trades it is not
 * making is the worst thing this product can put on a screen.
 *
 * The rule is per symbol, per sentence, and deliberately narrow:
 *
 *   - Only symbols actually in the portfolio count, so "reduces your total
 *     drift by 4.1pp" is not read as a claim to sell anything.
 *   - A symbol is associated with the *nearest* side word in its sentence, so
 *     "Selling what went up allows us to buy SOL" attributes BUY to SOL rather
 *     than both sides to everything in the clause.
 *   - A side word negated just before it ("not selling", "without buying") is
 *     not a claim.
 */
const BUY_WORDS = /\b(buy|buys|buying|bought|purchase|purchases|purchasing|accumulate|accumulating)\b/gi;
const SELL_WORDS = /\b(sell|sells|selling|sold|trim|trims|trimming|trimmed|offload|offloading)\b/gi;
const NEGATION = /\b(not|never|no|without|avoid|avoiding|rather than|instead of)\b[^.!?]{0,24}$/i;

export function claimedSidesNotInPlan(
  text: string,
  trades: { symbol: string; side: "BUY" | "SELL" }[],
  portfolioSymbols: string[],
): string[] {
  const planned = new Set(trades.map((t) => `${t.symbol}:${t.side}`));
  const violations = new Set<string>();

  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    // Where each side word sits, ignoring the negated ones.
    const marks: { at: number; side: "BUY" | "SELL" }[] = [];
    for (const [re, side] of [
      [BUY_WORDS, "BUY"],
      [SELL_WORDS, "SELL"],
    ] as const) {
      re.lastIndex = 0;
      for (const m of sentence.matchAll(re)) {
        const before = sentence.slice(0, m.index ?? 0);
        if (NEGATION.test(before)) continue;
        marks.push({ at: m.index ?? 0, side });
      }
    }
    if (marks.length === 0) continue;

    for (const symbol of portfolioSymbols) {
      // Word-boundary match so ETH does not fire inside a longer ticker.
      const symbolRe = new RegExp(String.raw`(^|[^A-Z0-9])${symbol}([^A-Z0-9]|$)`, "g");
      for (const hit of sentence.matchAll(symbolRe)) {
        const at = (hit.index ?? 0) + hit[1].length;
        const nearest = marks.reduce((best, m) =>
          Math.abs(m.at - at) < Math.abs(best.at - at) ? m : best,
        );
        if (!planned.has(`${symbol}:${nearest.side}`)) {
          violations.add(`${nearest.side} ${symbol}`);
        }
      }
    }
  }

  return [...violations].sort();
}

/**
 * Any bare money/percentage/pp/bps figure outside a {{TOKEN}}.
 * Run against the raw model output, before substitution.
 */
export function findBareFigures(text: string): string[] {
  const withoutTokens = text.replace(/\{\{[A-Z0-9_]+\}\}/g, "");
  const patterns = [
    /\$\s*\d[\d,]*(\.\d+)?/g, // $1,234.56
    /\d[\d,]*(\.\d+)?\s*%/g, // 12.3%
    /\d[\d,]*(\.\d+)?\s*(pp|bps)\b/gi, // 4.2pp / 30 bps
  ];
  const hits: string[] = [];
  for (const re of patterns) {
    const found = withoutTokens.match(re);
    if (found) hits.push(...found);
  }
  return hits;
}

export function substitute(text: string, tokens: Record<string, string>): { out: string; unknown: string[] } {
  const unknown: string[] = [];
  const out = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, key: string) => {
    const v = tokens[key];
    if (v == null) {
      unknown.push(key);
      return "";
    }
    return v;
  });
  // Collapse runs of spaces/tabs only. \s would also eat the blank line that
  // separates the headline from the body, which the UI splits on.
  return { out: out.replace(/[ \t]{2,}/g, " ").trim(), unknown };
}

export async function writeNarrative(
  ctx: RebalanceContext,
  timing: TimingDecision,
  trades: OrderedTrade[],
): Promise<string> {
  const tokens = buildTokens(ctx, timing, trades);
  const fallback = deterministicNarrative(ctx, timing, trades);

  if (!providerAvailable()) return fallback;

  const facts = {
    action: timing.action,
    primaryFactor: timing.primaryFactor,
    reasoning: timing.reasoning,
    assetsToActOn: timing.assetsToActOn,
    plan: trades.map((t) => ({ side: t.side, symbol: t.symbol, method: t.method })),
    // Values are shown so the model can judge magnitude and pick the right
    // placeholders — but it must emit the placeholder, not the value.
    availablePlaceholders: Object.fromEntries(
      Object.entries(tokens).map(([k, v]) => [`{{${k}}}`, v]),
    ),
  };

  try {
    const res = await structuredCall({
      schema: NarrativeSchema,
      schemaName: "narrative",
      system: SYSTEM,
      facts,
      temperature: 0.7,
      maxTokens: 1200,
    });

    if (!res.ok) {
      logDecision("narrative", "fallback", res.reason);
      return fallback;
    }
    const parsed = res.value;

    const raw = `${parsed.headline}\n\n${parsed.body}`;

    const bare = findBareFigures(raw);
    if (bare.length > 0) {
      logDecision("narrative", "fallback", `model typed figures directly: ${bare.join(", ")}`);
      return fallback;
    }

    const unnamed = unnamedAssets(raw, ctx.portfolio.rows.map((r) => r.symbol));
    if (unnamed.length > 0) {
      logDecision("narrative", "fallback", `figures quoted for unnamed assets: ${unnamed.join(", ")}`);
      return fallback;
    }

    // Prose that describes trades the plan does not contain. Checked against
    // the materialised legs, so it cannot pass by agreeing with intent.
    const contradictions = claimedSidesNotInPlan(
      raw,
      trades,
      ctx.portfolio.rows.map((r) => r.symbol),
    );
    if (contradictions.length > 0) {
      logDecision("narrative", "fallback", `claims trades not in the plan: ${contradictions.join(", ")}`);
      return fallback;
    }

    const { out, unknown } = substitute(raw, tokens);
    if (unknown.length > 0) {
      logDecision("narrative", "fallback", `unknown placeholders: ${unknown.join(", ")}`);
      return fallback;
    }
    if (!out.trim()) {
      logDecision("narrative", "fallback", "empty after substitution");
      return fallback;
    }

    logDecision("narrative", "ok");
    return out;
  } catch (err) {
    logDecision("narrative", "fallback", err instanceof Error ? err.message : String(err));
    return fallback;
  }
}

/** Template narrative. Same figures, no model. */
export function deterministicNarrative(
  ctx: RebalanceContext,
  timing: TimingDecision,
  trades: OrderedTrade[],
): string {
  const cb = ctx.costBenefit;
  const drift = pp(ctx.portfolio.totalDriftPp);

  if (timing.action === "HOLD") {
    // Two different HOLDs, and conflating them makes the product look broken:
    // "on target" is an empty state, whereas a judgment HOLD is the feature.
    const anythingOutside = ctx.portfolio.rows.some(
      (r) => r.outsideBand && r.symbol !== ctx.cashSymbol,
    );
    const headline = anythingOutside
      ? `Holding today — ${drift} of drift, but this is not the moment`
      : `On target — every position inside its band`;
    return `${headline}\n\n${timing.reasoning}`;
  }

  const sells = trades.filter((t) => t.side === "SELL").map((t) => t.symbol);
  const buys = trades.filter((t) => t.side === "BUY").map((t) => t.symbol);
  const legs: string[] = [];
  if (sells.length) legs.push(`selling ${list(sells)}`);
  if (buys.length) legs.push(`buying ${list(buys)}`);

  const headline =
    timing.action === "PARTIAL"
      ? `Partial rebalance — ${drift} of drift, acting on ${list(timing.assetsToActOn)}`
      : `Rebalance — ${drift} of drift to correct`;

  return `${headline}\n\nThe plan is ${legs.join(" and ")}. That removes ${pp(cb.driftReductionPp)} of drift for an estimated ${usd(cb.estimatedCostUsd)}, or ${cb.costBps.toFixed(1)} bps of the portfolio. ${timing.reasoning}`;
}

export function buildProposal(
  ctx: RebalanceContext,
  timing: TimingDecision,
  execution: Proposal["execution"],
  trades: OrderedTrade[],
  narrative: string,
  declined: CandidateTrade[] = [],
): Proposal {
  return { context: ctx, timing, execution, orderedTrades: trades, declined, narrative };
}

// --- formatting helpers: the single place figures become strings ------------

function usd(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function pp(n: number): string {
  return `${Number.isFinite(n) ? n.toFixed(1) : "0.0"}pp`;
}

function pct(n: number): string {
  return `${Number.isFinite(n) ? n.toFixed(1) : "0.0"}%`;
}

function trimQty(n: number): string {
  return n.toFixed(8).replace(/\.?0+$/, "");
}

function list(xs: string[]): string {
  if (xs.length === 0) return "nothing";
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
