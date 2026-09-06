/**
 * NAV, drift and bands — DESIGN.md §5.1–5.3.
 *
 * Pure functions. No I/O, no LLM, no auth. Every number the user sees
 * originates here.
 */

import type {
  Allocation,
  BandConfig,
  DriftRow,
  Holding,
  PortfolioState,
} from "../types";
import { flattenTargets } from "./allocation";

export const DEFAULT_BANDS: BandConfig = {
  absoluteFloorPp: 2.0,
  relativeBandPct: 0.25,
};

/**
 * §5.1 — NAV = Σ (qty_i × price_i) over spot balances.
 * Cash counts at its quoted price, which the adapter reports as 1.0 for USDT.
 */
export function computeNav(holdings: Holding[]): number {
  return holdings.reduce((sum, h) => sum + h.valueUsd, 0);
}

/** Build Holding rows from raw quantities and a price map. Cash prices at 1.0. */
export function buildHoldings(
  quantities: Record<string, number>,
  prices: Record<string, number>,
  cashSymbol: string,
): Holding[] {
  return Object.entries(quantities)
    .filter(([, qty]) => qty > 0)
    .map(([symbol, qty]) => {
      const priceUsd = symbol === cashSymbol ? 1 : (prices[symbol] ?? 0);
      return { symbol, qty, priceUsd, valueUsd: qty * priceUsd };
    });
}

/**
 * §5.3 — band_i = max(absoluteFloorPp, relativeBandPct × targetWeight_i × 100)
 *
 * A 40% target gets a ±10pp band; a 5% target gets the ±2pp floor.
 */
export function bandFor(targetWeight: number, bands: BandConfig): number {
  return Math.max(bands.absoluteFloorPp, bands.relativeBandPct * targetWeight * 100);
}

/**
 * §5.2 — drift table.
 *
 * totalDriftPp = Σ|driftPp| / 2. Halving is correct because over- and
 * under-weights always sum to the same magnitude; the result is the share of
 * the portfolio that must change hands to return to target.
 */
export function computeDrift(
  holdings: Holding[],
  allocation: Allocation,
  opts: { bands?: BandConfig; asOf?: string } = {},
): PortfolioState {
  const bands = opts.bands ?? DEFAULT_BANDS;
  const navUsd = computeNav(holdings);
  const targets = flattenTargets(allocation);

  // Cash is an implicit residual target of 0 unless explicitly allocated —
  // holding cash you did not ask for is itself a drift.
  const symbols = new Set<string>([
    ...Object.keys(targets),
    ...holdings.map((h) => h.symbol),
  ]);

  const valueBySymbol = new Map<string, number>();
  for (const h of holdings) {
    valueBySymbol.set(h.symbol, (valueBySymbol.get(h.symbol) ?? 0) + h.valueUsd);
  }

  const rows: DriftRow[] = [];
  for (const symbol of symbols) {
    const targetWeight = targets[symbol] ?? 0;
    const currentValueUsd = valueBySymbol.get(symbol) ?? 0;
    // A zero NAV portfolio has no meaningful weights; report zeros rather than NaN.
    const currentWeight = navUsd > 0 ? currentValueUsd / navUsd : 0;
    const driftPp = (currentWeight - targetWeight) * 100;
    const targetValueUsd = navUsd * targetWeight;
    const bandPp = bandFor(targetWeight, bands);

    rows.push({
      symbol,
      targetWeight,
      currentWeight,
      driftPp,
      deltaUsd: targetValueUsd - currentValueUsd,
      outsideBand: Math.abs(driftPp) > bandPp,
      bandPp,
      targetValueUsd,
      currentValueUsd,
    });
  }

  rows.sort((a, b) => Math.abs(b.driftPp) - Math.abs(a.driftPp));

  const totalDriftPp = rows.reduce((s, r) => s + Math.abs(r.driftPp), 0) / 2;

  return {
    navUsd,
    rows,
    totalDriftPp,
    asOf: opts.asOf ?? new Date().toISOString(),
  };
}

/**
 * Total drift that would remain after a set of trades executes at their
 * estimated prices. Used for driftReductionPp in §6.
 */
export function projectDriftAfter(
  state: PortfolioState,
  deltasBySymbol: Record<string, number>,
): number {
  // Executing a trade moves value between an asset and cash; NAV is unchanged
  // except for costs, which are accounted separately in the cost/benefit block.
  const nav = state.navUsd;
  if (nav <= 0) return state.totalDriftPp;

  let sum = 0;
  for (const row of state.rows) {
    const applied = deltasBySymbol[row.symbol] ?? 0;
    const newValue = row.currentValueUsd + applied;
    const newWeight = newValue / nav;
    sum += Math.abs((newWeight - row.targetWeight) * 100);
  }
  return sum / 2;
}
