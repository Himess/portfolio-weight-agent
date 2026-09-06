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

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { isMoveInProgress } from "../core/signals";
import type { RebalanceContext, TimingDecision } from "../types";
import { MODEL, getClient, hasCredentials, logDecision, samplingFor } from "./client";
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

Respect the user's stated preference:
- patient  — tolerate more drift, act less often, weight cost heavily.
- balanced — the default trade-off.
- tight    — track the target closely, accept higher costs to do it.

assetsToActOn must be a subset of the symbols listed as outsideBand. For HOLD it
must be empty. Write reasoning in 2-4 sentences, addressed to the portfolio
owner, plainly, with no hedging boilerplate.`;

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
  if (!hasCredentials()) {
    return deterministicTiming(ctx, "no ANTHROPIC_API_KEY configured");
  }

  const facts = buildFacts(ctx, outsideBand);

  try {
    const res = await getClient().messages.parse({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      ...samplingFor("analytical"),
      messages: [{ role: "user", content: JSON.stringify(facts, null, 2) }],
      output_config: { format: zodOutputFormat(TimingSchema) },
    });

    const parsed = res.parsed_output;
    if (!parsed) return deterministicTiming(ctx, "model returned no parseable output");

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
    navUsd: round(ctx.portfolio.navUsd, 2),
    totalDriftPp: round(ctx.portfolio.totalDriftPp, 3),
    daysSinceLastRebalance: ctx.daysSinceLastRebalance,
    outsideBand,
    positions: ctx.portfolio.rows
      .filter((r) => r.symbol !== ctx.cashSymbol || r.targetWeight > 0)
      .map((r) => {
        const s = signalBySymbol.get(r.symbol);
        return {
          symbol: r.symbol,
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
