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

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import type { OrderedTrade, Proposal, RebalanceContext, TimingDecision } from "../types";
import { MODEL, getClient, hasCredentials, logDecision, samplingFor } from "./client";
import { NarrativeSchema } from "./schemas";

const SYSTEM = `You write the two or three sentences a portfolio owner reads when the agent reports back.

You must NOT type any figure yourself. Every number, amount, percentage or
ticker-with-a-number comes from the placeholder list you are given. Write the
placeholder exactly as shown, including the braces, e.g. {{TOTAL_DRIFT}}. The
system substitutes real values afterwards. If you type a figure directly, the
whole response is discarded.

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
  return { out: out.replace(/\s{2,}/g, " ").trim(), unknown };
}

export async function writeNarrative(
  ctx: RebalanceContext,
  timing: TimingDecision,
  trades: OrderedTrade[],
): Promise<string> {
  const tokens = buildTokens(ctx, timing, trades);
  const fallback = deterministicNarrative(ctx, timing, trades);

  if (!hasCredentials()) return fallback;

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
    const res = await getClient().messages.parse({
      model: MODEL,
      max_tokens: 1200,
      system: SYSTEM,
      ...samplingFor("creative"),
      messages: [{ role: "user", content: JSON.stringify(facts, null, 2) }],
      output_config: { format: zodOutputFormat(NarrativeSchema) },
    });

    const parsed = res.parsed_output;
    if (!parsed) {
      logDecision("narrative", "fallback", "no parseable output");
      return fallback;
    }

    const raw = `${parsed.headline}\n\n${parsed.body}`;

    const bare = findBareFigures(raw);
    if (bare.length > 0) {
      logDecision("narrative", "fallback", `model typed figures directly: ${bare.join(", ")}`);
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
): Proposal {
  return { context: ctx, timing, execution, orderedTrades: trades, narrative };
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
