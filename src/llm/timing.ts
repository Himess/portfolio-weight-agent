/**
 * §7.1 — Timing: "should we act now?"
 *
 * This is the decision that makes it an agent. A bot rebalances because a
 * threshold was crossed; this weighs cost against benefit and market state,
 * and is allowed to conclude that today is not the day.
 *
 * The model receives only precomputed facts. It returns a choice and a reason —
 * never a number that reaches an order.
 */

import { isMoveInProgress } from "../core/signals";
import type { RebalanceContext, TimingDecision } from "../types";
import { logDecision } from "./client";
import { askBudgetFor } from "../core/bands";
import { providerAvailable, structuredCall } from "./provider";
import { TimingSchema } from "./schemas";

const SYSTEM = `You decide WHEN a portfolio rebalance should happen. You do not compute anything.

Every number you are given was computed deterministically. Never restate a number
that is not in the input, and never invent quantities, prices or percentages.

You choose one of three actions:

- REBALANCE — act on everything that is outside its band.
- PARTIAL   — act on some of the drifted assets and leave the rest for later.
- HOLD      — do nothing today.

HOLD is a real, expected outcome, not a failure. Choose it when acting now is
worse than waiting. Legitimate reasons:

- The move that created the drift is still in progress. Buying an asset that is
  still falling hard, or selling one still ripping upward, is catching a falling
  knife. The volRatio and priceChange4h figures tell you this; "moveInProgress"
  is precomputed for you.
- costPerPpUsd is high relative to the portfolio. The cure can cost more than
  the disease. Compare estimatedCostUsd to NAV, and costBps to the drift you
  would remove.
- The whole market moved together. Absolute values changed a lot but relative
  weights barely did — check whether total drift is actually small.
- Volatility has spiked, so today's bands should effectively be wider than usual.

Choose REBALANCE or PARTIAL when drift is real, the cost is proportionate, and
the market is not mid-move. Staleness matters too: a portfolio that has drifted
for many weeks deserves action even at a mediocre cost.

ATTENTION IS THE SCARCE RESOURCE, NOT MONEY.

Correcting drift is cheap here — only the deviation is traded, and a year of
constant correction costs well under 1% of the portfolio. What is not cheap is
the owner: every proposal you make has to be approved by hand in Binance. An
unapproved proposal tracks nothing, and a person who is asked six times a day
stops reading.

You are given "askedLast24h", "dailyAskBudget" and "asksRemaining". When you
hold back for this reason, say so with primaryFactor "attention" — it is a real
reason and it has its own name. The budget is what normal looks like for this
owner's setting, not a limit you must obey:

- Well under budget: judge the breach on its merits.
- At or over budget: the bar rises sharply. HOLD unless this breach is clearly
  worse than the ones they have already approved today — a position that has
  kept running, a new asset breaking down, a cost that will only grow. "It is
  outside its band" is not enough on its own once the budget is spent, because
  everything you showed them earlier was outside its band too.
- Far over budget on a violently moving day: one message and no proposals is
  usually the right answer. You looked, and nothing yet deserved their
  signature.

Exceeding the budget is allowed when the situation genuinely warrants it. Doing
it out of completeness is not.

Never say any of this out loud, and never mention a budget or a count. Give the
reason in terms of the portfolio: what moved, what it would cost, why now or why
not yet.

Respect the user's stated preference. It has already set the band you are
shown, so it is not asking you to re-decide the threshold — it tells you how
this owner weighs cost against tracking when the call is close:
- patient    — tolerate more drift, weight cost heavily.
- balanced   — the default trade-off.
- tight      — track the target closely, accept higher costs to do it.
- continuous — track almost exactly. Small, frequent corrections are expected
               and wanted; only real hazards (a move still running, unusable
               depth) justify waiting.

assetsToActOn must be a subset of the "outsideBand" list you are given, exactly
as spelled there. For HOLD it must be empty.

The cash position (see "cashSymbol") is shown for context but is never traded
directly, so it never appears in outsideBand and must never appear in
assetsToActOn — even when its own drift is large. Holding too much or too little
cash is corrected by buying or selling the other positions.

Write reasoning in 2-4 sentences, addressed to the portfolio owner, plainly,
with no hedging boilerplate.

The reasoning is shown to the owner verbatim, so write it in their language, not
in the language of the input. Never name a field from the JSON you were given —
no "moveInProgress", "volRatio", "costPerPpUsd", "outsideBand", no "set to true".
Say what the figures mean instead: "the move is still running", "it is twice as
volatile as usual", "the correction costs more than the drift it removes", "it
has crossed its tolerance".`;

/**
 * Deterministic default used whenever the model is unavailable or its answer
 * fails validation: act on everything outside its band. This is the plain
 * threshold behaviour — correct, if unsubtle — and it is always labelled as a
 * fallback in the UI so the user knows no judgment was applied.
 */
export function deterministicTiming(
  ctx: RebalanceContext,
  reason: string,
): TimingDecision {
  const outside = ctx.portfolio.rows
    .filter((r) => r.outsideBand && r.symbol !== ctx.cashSymbol)
    .map((r) => r.symbol);

  if (outside.length === 0) {
    // Total drift is an aggregate; bands are per position. Several small
    // deviations can add up to a meaningful total while no single position has
    // moved far enough from its own target to be worth a trade. Say that
    // explicitly — otherwise "7.6pp of drift" next to "nothing to do" reads as
    // a contradiction, and the user stops trusting the numbers.
    const widest = ctx.portfolio.rows
      .filter((r) => r.symbol !== ctx.cashSymbol)
      .reduce<{ symbol: string; driftPp: number; bandPp: number } | null>(
        (best, r) =>
          !best || Math.abs(r.driftPp) > Math.abs(best.driftPp)
            ? { symbol: r.symbol, driftPp: r.driftPp, bandPp: r.bandPp }
            : best,
        null,
      );

    const detail = widest
      ? ` The widest is ${widest.symbol}, ${Math.abs(widest.driftPp).toFixed(1)}pp from target against a ${widest.bandPp.toFixed(1)}pp band.`
      : "";

    return {
      action: "HOLD",
      assetsToActOn: [],
      reasoning:
        `Total drift is ${ctx.portfolio.totalDriftPp.toFixed(1)}pp, but that is spread across positions and no single one has left its own tolerance band, so there is nothing worth trading.${detail}`,
      primaryFactor: "drift_magnitude",
      fellBack: true,
      fallbackReason: reason,
    };
  }

  return {
    action: "REBALANCE",
    assetsToActOn: outside,
    reasoning: `Rebalancing every position outside its band (${outside.join(", ")}). This is the deterministic band rule — the judgment step was unavailable, so no timing call was applied.`,
    primaryFactor: "drift_magnitude",
    fellBack: true,
    fallbackReason: reason,
  };
}

export async function decideTiming(ctx: RebalanceContext): Promise<TimingDecision> {
  const outsideBand = ctx.portfolio.rows
    .filter((r) => r.outsideBand && r.symbol !== ctx.cashSymbol)
    .map((r) => r.symbol);

  if (outsideBand.length === 0) {
    return deterministicTiming(ctx, "nothing outside band");
  }
  if (!providerAvailable()) {
    return deterministicTiming(ctx, "no LLM provider configured");
  }

  const facts = buildFacts(ctx, outsideBand);

  try {
    const res = await structuredCall({
      schema: TimingSchema,
      schemaName: "timing_decision",
      system: SYSTEM,
      facts,
      // A decision, not prose. The same fact sheet must produce the same
      // verdict: a rebalancing call that flips between HOLD and PARTIAL on
      // re-runs of identical input is not auditable, and this one was
      // observed doing exactly that at 0.2. Variety belongs in the
      // narrative, which stays warm.
      temperature: 0,
      maxTokens: 2000,
    });

    if (!res.ok) return deterministicTiming(ctx, res.reason);
    const parsed = res.value;

    // Facts the model does not get to assert: it may only name assets we
    // actually flagged. DESIGN.md §7.1 — "Reject otherwise."
    const allowed = new Set(outsideBand);
    const invalid = parsed.assetsToActOn.filter((s) => !allowed.has(s));
    if (invalid.length > 0) {
      return deterministicTiming(
        ctx,
        `model named assets that are not outside band: ${invalid.join(", ")}`,
      );
    }

    if (!parsed.reasoning.trim()) {
      return deterministicTiming(ctx, "model returned empty reasoning");
    }

    // Normalize the action/assets pairing so downstream code can trust it.
    let assets = parsed.assetsToActOn;
    let action = parsed.action;

    if (action === "HOLD") {
      assets = [];
    } else if (action === "REBALANCE") {
      // REBALANCE means everything outside band, whatever the model listed.
      assets = outsideBand;
    } else if (assets.length === 0) {
      // PARTIAL with nothing to act on is a HOLD in disguise; treat it as one
      // rather than silently emitting an empty plan.
      action = "HOLD";
    }

    logDecision("timing", "ok", `${action} (${parsed.primaryFactor})`);
    return {
      action,
      assetsToActOn: assets,
      reasoning: parsed.reasoning.trim(),
      primaryFactor: parsed.primaryFactor,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logDecision("timing", "fallback", msg);
    return deterministicTiming(ctx, msg);
  }
}

/** The precomputed fact sheet handed to the model. Numbers only, no judgment. */
function buildFacts(ctx: RebalanceContext, outsideBand: string[]) {
  const signalBySymbol = new Map(ctx.signals.map((s) => [s.symbol, s]));

  return {
    asOf: ctx.asOf,
    preference: ctx.preference,
    askedLast24h: ctx.askedLast24h ?? 0,
    dailyAskBudget: askBudgetFor(ctx.preference),
    asksRemaining: Math.max(0, askBudgetFor(ctx.preference) - (ctx.askedLast24h ?? 0)),
    navUsd: round(ctx.portfolio.navUsd, 2),
    totalDriftPp: round(ctx.portfolio.totalDriftPp, 3),
    daysSinceLastRebalance: ctx.daysSinceLastRebalance,
    outsideBand,
    cashSymbol: ctx.cashSymbol,
    positions: ctx.portfolio.rows
      .filter((r) => r.symbol !== ctx.cashSymbol || r.targetWeight > 0)
      .map((r) => {
        const s = signalBySymbol.get(r.symbol);
        const isCash = r.symbol === ctx.cashSymbol;
        return {
          symbol: r.symbol,
          // Cash is shown because its weight is informative, but it is never
          // traded against itself — its drift is resolved by the other legs.
          // Without this flag the model sees cash outside its band and
          // reasonably proposes acting on it, which the validator then rejects.
          tradable: !isCash,
          targetWeightPct: round(r.targetWeight * 100, 2),
          currentWeightPct: round(r.currentWeight * 100, 2),
          driftPp: round(r.driftPp, 2),
          bandPp: round(r.bandPp, 2),
          outsideBand: r.outsideBand,
          deltaUsd: round(r.deltaUsd, 2),
          realizedVol24hPctPerHour: s ? round(s.realizedVol24h, 3) : null,
          realizedVol4hPctPerHour: s ? round(s.realizedVol4h, 3) : null,
          volRatio: s ? round(s.volRatio, 2) : null,
          priceChange4hPct: s ? round(s.priceChange4hPct, 2) : null,
          priceChange24hPct: s ? round(s.priceChange24hPct, 2) : null,
          moveInProgress: s ? isMoveInProgress(s, r.driftPp) : false,
        };
      }),
    plannedTrades: ctx.candidates.map((c) => ({
      id: c.id,
      side: c.side,
      symbol: c.symbol,
      estNotionalUsd: round(c.estNotionalUsd, 2),
      estFeeUsd: round(c.estFeeUsd, 2),
      estSlippageUsd: round(c.estSlippageUsd, 2),
      slippageBps: round(c.slippageBps, 1),
      bookExhausted: c.bookExhausted,
    })),
    costBenefit: {
      estimatedCostUsd: round(ctx.costBenefit.estimatedCostUsd, 2),
      costBps: round(ctx.costBenefit.costBps, 1),
      totalDriftBeforePp: round(ctx.costBenefit.totalDriftBeforePp, 3),
      totalDriftAfterPp: round(ctx.costBenefit.totalDriftAfterPp, 3),
      driftReductionPp: round(ctx.costBenefit.driftReductionPp, 3),
      costPerPpUsd: round(ctx.costBenefit.costPerPpUsd, 2),
    },
  };
}

function round(n: number, dp: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(dp)) : 0;
}
