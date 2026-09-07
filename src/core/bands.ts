/**
 * How much drift counts as drift.
 *
 * This was the one thing the tracking preference did not control, and that was
 * a real hole. "Patient", "Balanced" and "Tight" were passed to the timing
 * model and nowhere else, so every preference used the identical band — which
 * meant a tight tracker and a patient one were shown a portfolio at the exact
 * same moment. The preference could only make the agent decline something it
 * had already been shown; it could never make it look at something it had not.
 *
 * Now the preference sets the band, deterministically, and the division of
 * labour is clean:
 *
 *   the owner decides how much deviation is worth a look   (this file)
 *   arithmetic decides whether that line has been crossed  (core/drift.ts)
 *   the agent decides what to do about it, including wait  (llm/timing.ts)
 *
 * The shape is the 5/25 rule: a relative share of the target weight, floored so
 * a tiny position is not hair-triggered and capped so a large one is not
 * effectively unmonitored.
 *
 *   band_i = min(cap, max(floor, relativeBandPct × targetWeight_i × 100))
 *
 * The numbers below are measured, not guessed, and the first version of them
 * was wrong in an instructive way. They were set from equity-market convention
 * — annual-ish rebalancing on 5% bands — which produced 2-6 decisions a year and
 * a portfolio sitting an average of 4.16pp away from its target. That is a
 * rebalancing tool that barely rebalances.
 *
 * `npm run bands` measured the actual trade-off over a year of real hourly
 * closes, with real fees and real order-book slippage on every fill:
 *
 *   band on a 40%   rebalances/yr   cost/yr   mean drift
 *   ±8.00pp                     1     0.00%      6.64pp
 *   ±5.00pp                     6     0.02%      4.16pp
 *   ±2.50pp                    17     0.04%      2.10pp
 *   ±1.50pp                    67     0.07%      1.10pp
 *   ±0.75pp                   267     0.15%      0.57pp
 *   ±0.40pp                   822     0.26%      0.30pp
 *   never                       0     0.00%      9.85pp
 *
 * Frequent rebalancing is cheap here because only the *deviation* is traded, not
 * the portfolio: 822 corrections a year cost 0.26% of NAV and cut average drift
 * by 33x. The equity-market intuition that frequent rebalancing is expensive
 * does not transfer, and the old defaults were paying for a caution that the
 * measurement does not support.
 *
 * The binding constraint turned out not to be money. It is attention — every
 * correction needs a human approval in Binance, and nobody approves 822 things a
 * year. So the ladder spans the measured curve and says what each rung costs in
 * interruptions, and the owner picks the one they will actually keep up with.
 *
 * The rungs below are exactly the measured rows; nothing is interpolated.
 */

import { bandFor } from "./drift";
import { logReturns, stdev } from "./signals";
import type { BandConfig, Kline, Preference } from "../types";

// ---------------------------------------------------------------------------
// Volatility scaling
// ---------------------------------------------------------------------------

/**
 * The band a *typical* asset gets, unscaled.
 *
 * Measured, not chosen: over the year from 2025-09-06, annualized hourly-return
 * volatility was BTC 43%, ETH 60%, SOL 67%, AVAX 74%, SUI 86%, TAO 100%,
 * WLD 121%. ETH sits in the middle of that and is the anchor.
 */
export const REFERENCE_VOL_PCT = 60;

/** Bounds on the multiplier, so one strange fortnight cannot produce a strange band. */
const MIN_SCALE = 0.6;
const MAX_SCALE = 2.5;

/** Annualized realized volatility, in percent, from hourly closes. */
export function realizedVolPct(closes: number[]): number | null {
  // Below a couple of days of history the estimate is noise; say so rather
  // than return a number that looks like a measurement.
  if (closes.length < 48) return null;
  return stdev(logReturns(closes)) * Math.sqrt(8760) * 100;
}

/**
 * How much wider this asset's band should be than a typical one.
 *
 * A volatile asset drifts further for no reason, and much of that drift
 * reverses on its own. Correcting it immediately means paying fees and spread
 * to undo noise — so the more an asset moves, the more deviation is worth
 * tolerating before acting. The optimal no-trade band grows roughly with
 * volatility^(2/3), which is the exponent used here; the cube root keeps a
 * doubling of volatility from doubling the band.
 *
 * This is the piece that makes the system respond to the market instead of to a
 * constant. It is deliberately deterministic: the model still never picks a
 * threshold, it only decides what to do once one is crossed.
 */
export function volScaleFor(volPct: number | null): number {
  if (volPct == null || !Number.isFinite(volPct) || volPct <= 0) return 1;
  const raw = (volPct / REFERENCE_VOL_PCT) ** (2 / 3);
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));
}

/** Band multipliers for a set of symbols, from their recent hourly closes. */
export function volScales(klinesBySymbol: Record<string, Kline[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [symbol, klines] of Object.entries(klinesBySymbol)) {
    out[symbol] = volScaleFor(realizedVolPct(klines.map((k) => k.close)));
  }
  return out;
}

export const BANDS: Record<Preference, BandConfig> = {
  // ~17 corrections a year, 0.04% of NAV, 2.10pp average drift.
  patient: { absoluteFloorPp: 1.0, relativeBandPct: 0.15, absoluteCapPp: 2.5 },

  // ~67 a year — roughly weekly. 0.07% of NAV, 1.10pp average drift.
  balanced: { absoluteFloorPp: 0.7, relativeBandPct: 0.06, absoluteCapPp: 1.5 },

  // ~267 a year — most weekdays. 0.15% of NAV, 0.57pp average drift.
  tight: { absoluteFloorPp: 0.4, relativeBandPct: 0.03, absoluteCapPp: 0.75 },

  // ~822 a year — a few times a day. 0.26% of NAV, 0.30pp average drift. Only
  // worth choosing if the approvals will actually happen; an unapproved
  // proposal tracks nothing.
  continuous: { absoluteFloorPp: 0.2, relativeBandPct: 0.015, absoluteCapPp: 0.4 },
};

export function bandsFor(preference: Preference): BandConfig {
  return BANDS[preference] ?? BANDS.balanced;
}

/**
 * How many times a day this owner is willing to be asked.
 *
 * Not a rate limit and not enforced anywhere — it is context the agent is given
 * so a bare "you have asked 8 times" becomes a comparison it can act on. The
 * agent may still exceed it for something that deserves the interruption, and
 * may stay well under it on a quiet day. Deciding that is its job; the numbers
 * only say what normal looks like for this setting.
 *
 * They are set above the *average* rate each rung produces (0.05/day for
 * patient up to ~2/day for continuous, measured) because the problem is never
 * the average — it is the cluster. A violent morning generates ten breaches in
 * six hours, and this is what stops ten proposals coming with them.
 */
export const DAILY_ASK_BUDGET: Record<Preference, number> = {
  patient: 1,
  balanced: 2,
  tight: 4,
  continuous: 8,
};

export function askBudgetFor(preference: Preference): number {
  return DAILY_ASK_BUDGET[preference] ?? DAILY_ASK_BUDGET.balanced;
}

/**
 * The band a given target weight gets, in percentage points — so the UI can
 * show the consequence of the choice ("±10.0pp on a 40% position") instead of
 * three adjectives.
 */
export function bandPpFor(preference: Preference, targetWeight: number, volScale = 1): number {
  // Delegates rather than restating the formula. It restated it once, and
  // silently kept showing uncapped numbers after the cap was added.
  return bandFor(targetWeight, bandsFor(preference), volScale);
}
