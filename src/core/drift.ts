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
import { BANDS, bandFor } from "./bands";

/**
 * §5.1 — NAV = Σ (qty_i × price_i) over spot balances.
 * Cash counts at its quoted price, which the adapter reports as 1.0 for USDT.
 */
export function computeNav(holdings: Holding[]): number {
  return holdings.reduce((sum, h) => sum + h.valueUsd, 0);
}

/**
 * A price we do not have.
 *
 * This exists because the alternative was worse than an error. A missing price
 * used to fall back to zero, which is not a missing price — it is a confident
 * claim that the asset is worthless. Downstream everything believed it: the
 * position showed 0.0% weight, its full target weight showed as drift, and half
 * a headline drift figure on the deployed site was two assets the active data
 * source had never heard of. The narrative then talked about buying them while
 * the plan could not trade them, because a zero price produces no candidate.
 *
 * Nothing about that is recoverable by guessing. Stop instead.
 */
export class MissingPriceError extends Error {
  constructor(readonly symbols: string[]) {
    super(
      `No price for ${symbols.join(", ")}. ` +
        `The active data source does not cover ${symbols.length === 1 ? "it" : "them"}.`,
    );
    this.name = "MissingPriceError";
  }
}

/** Symbols that need a price and do not have a usable one. Cash never does. */
export function unpricedSymbols(
  symbols: string[],
  prices: Record<string, number>,
  cashSymbol: string,
): string[] {
  return symbols.filter((s) => {
    if (s === cashSymbol) return false;
    const p = prices[s];
    return !Number.isFinite(p) || p <= 0;
  });
}

/**
 * Build Holding rows from raw quantities and a price map. Cash prices at 1.0.
 *
 * Throws rather than pricing anything at zero — see MissingPriceError.
 */
export function buildHoldings(
  quantities: Record<string, number>,
  prices: Record<string, number>,
  cashSymbol: string,
): Holding[] {
  const held = Object.entries(quantities).filter(([, qty]) => qty > 0);

  const unpriced = unpricedSymbols(
    held.map(([symbol]) => symbol),
    prices,
    cashSymbol,
  );
  if (unpriced.length > 0) throw new MissingPriceError(unpriced);

  return held.map(([symbol, qty]) => {
    const priceUsd = symbol === cashSymbol ? 1 : prices[symbol];
    return { symbol, qty, priceUsd, valueUsd: qty * priceUsd };
  });
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
  opts: {
    /** Omitted means the balanced rung of the ladder — never a separate copy of it. */
    bands?: BandConfig;
    asOf?: string;
    /**
     * Per-symbol band multiplier from realized volatility (see core/bands.ts).
     * Absent means 1.0 everywhere, which is exactly the fixed-band behaviour —
     * so nothing that does not supply it changes.
     */
    volScale?: Record<string, number>;
    /** Measurement escape hatch for `npm run bands`; the product never sets it. */
    scaleCap?: boolean;
  } = {},
): PortfolioState {
  const bands = opts.bands ?? BANDS.balanced;
  const navUsd = computeNav(holdings);
  const targets = flattenTargets(allocation);

  // Cash is an implicit residual target of 0 unless explicitly allocated —
  // holding cash you did not ask for is itself a drift.
  const symbols = new Set<string>([
    ...Object.keys(targets),
    ...holdings.map((h) => h.symbol),
  ]);

  const valueBySymbol = new Map<string, number>();
  const qtyBySymbol = new Map<string, number>();
  for (const h of holdings) {
    valueBySymbol.set(h.symbol, (valueBySymbol.get(h.symbol) ?? 0) + h.valueUsd);
    qtyBySymbol.set(h.symbol, (qtyBySymbol.get(h.symbol) ?? 0) + h.qty);
  }

  const rows: DriftRow[] = [];
  for (const symbol of symbols) {
    const targetWeight = targets[symbol] ?? 0;
    const currentValueUsd = valueBySymbol.get(symbol) ?? 0;
    // A zero NAV portfolio has no meaningful weights; report zeros rather than NaN.
    const currentWeight = navUsd > 0 ? currentValueUsd / navUsd : 0;
    const driftPp = (currentWeight - targetWeight) * 100;
    const targetValueUsd = navUsd * targetWeight;
    const bandPp = bandFor(targetWeight, bands, opts.volScale?.[symbol] ?? 1, {
      scaleCap: opts.scaleCap === true,
    });

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
      qty: qtyBySymbol.get(symbol) ?? 0,
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
 * Is this someone entering, rather than someone correcting?
 *
 * The case the product was built blind to. A person holding only cash who sets
 * 50/30/20 has ~80pp of drift, every risk leg is unfunded, and every band is
 * breached by a mile. A threshold rule buys the whole portfolio in one minute,
 * which is not rebalancing — it is committing everything at a single price and
 * calling it discipline. Whether that minute was a good one is unknowable, and
 * unknowable is exactly the thing this agent is supposed to refuse to pretend
 * about.
 *
 * Detected deterministically so the model is told, not asked to notice: cash
 * well above its own target, and most risk legs holding almost nothing against
 * theirs.
 */
export type EntryShape = {
  initialEntry: boolean;
  /** Targets funded at less than a tenth of their weight. */
  unfundedSymbols: string[];
  /** How far cash sits above its own target, in percentage points. */
  cashOverPp: number;
};

export function entryShape(state: PortfolioState, cashSymbol: string): EntryShape {
  const cash = state.rows.find((r) => r.symbol === cashSymbol);
  const risk = state.rows.filter((r) => r.symbol !== cashSymbol && r.targetWeight > 0);

  const unfundedSymbols = risk
    .filter((r) => r.currentWeight < r.targetWeight * 0.1)
    .map((r) => r.symbol);

  const cashOverPp = cash ? cash.driftPp : 0;

  return {
    // Both conditions, because either alone is something else: a big cash
    // overweight with funded legs is ordinary drift, and one unfunded leg is a
    // position someone just added.
    initialEntry:
      cashOverPp > 25 && risk.length > 0 && unfundedSymbols.length >= Math.ceil(risk.length / 2),
    unfundedSymbols,
    cashOverPp: Number(cashOverPp.toFixed(2)),
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
