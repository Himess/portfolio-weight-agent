/**
 * Candidate trade generation — DESIGN.md §5.4.
 *
 * Order of operations is load-bearing:
 *   1. drop dust below minTradeUsd
 *   2. apply exchange filters (LOT_SIZE, MIN_NOTIONAL, PRICE_FILTER)
 *   3. sequence sells before buys
 *   4. emit with fee + slippage estimates
 *
 * The LLM may reorder or drop these. It may never invent one or change a qty.
 */

import type {
  CandidateTrade,
  ExchangeInfo,
  OrderBook,
  PlanConfig,
  PortfolioState,
  Side,
} from "../types";
import { BANDS } from "./bands";
import { midPrice, walkBookByQty } from "./slippage";

export const DEFAULT_PLAN_CONFIG: PlanConfig = {
  // The balanced rung of the ladder, not a second copy of it.
  bands: BANDS.balanced,
  minTradeUsd: 10,
  feeRate: 0.001, // 10 bps taker, Binance spot default tier
};

/**
 * Candidates that were sized and priced and then not sent.
 *
 * The product's claim is that it can decline, so what it declined has to be a
 * value, not a sentence. Matched on side and symbol rather than candidate id:
 * a PARTIAL regenerates its candidate set for the chosen subset, so the ids of
 * the legs that were dropped no longer exist anywhere to compare against.
 */
export function declinedTrades(
  candidates: CandidateTrade[],
  sent: { side: Side; symbol: string }[],
): CandidateTrade[] {
  const going = new Set(sent.map((t) => `${t.side}:${t.symbol}`));
  return candidates.filter((c) => !going.has(`${c.side}:${c.symbol}`));
}

/**
 * What the measured book says the execution method should be.
 *
 * Not the model's arithmetic. The prompt described when a resting order beats
 * crossing the spread, and a small model read a 13.9bps slippage figure and
 * chose market anyway — the rule was there and simply not weighed. So the
 * comparison is done here and handed over as a suggestion the model may
 * override with a reason, which is the same shape as every other decision in
 * this project: precomputed options, model selects.
 *
 * The trade-off is real in both directions. Crossing costs `slippageBps`, now
 * and for certain. Resting saves most of that and risks not filling at all,
 * which leaves the drift in place — so on a deep book, where crossing costs
 * about as much as the spread on a bus fare, waiting buys nothing.
 */
export const LIMIT_WORTH_IT_BPS = 8;

export function suggestMethod(c: Pick<CandidateTrade, "slippageBps" | "bookExhausted">): {
  method: "spot_market" | "spot_limit";
  limitPriceOffsetBps: number;
  because: string;
} {
  const slip = Math.abs(c.slippageBps);

  if (c.bookExhausted) {
    // Nothing on the book at this size. Crossing would take whatever price is
    // left, which is the one case where fill risk is the lesser problem.
    return {
      method: "spot_limit",
      limitPriceOffsetBps: 10,
      because: "the book was exhausted at this size",
    };
  }

  if (slip < LIMIT_WORTH_IT_BPS) {
    return {
      method: "spot_market",
      limitPriceOffsetBps: 0,
      because: `crossing costs only ${slip.toFixed(1)}bps`,
    };
  }

  // Rest inside the touch by about half of what crossing would cost: enough to
  // be worth doing, close enough to still fill.
  return {
    method: "spot_limit",
    limitPriceOffsetBps: Math.min(50, Math.round(slip / 2)),
    because: `crossing costs ${slip.toFixed(1)}bps on a thin book`,
  };
}

/** Decimal places implied by a step/tick size, e.g. 0.001 -> 3. */
export function precisionOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 8;
  const s = step.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  return s.length - dot - 1;
}

/**
 * Round DOWN to the exchange step size. Rounding down (never up) guarantees we
 * never place an order larger than the drift justifies.
 *
 * The 1e-9 nudge absorbs binary FP error so that e.g. 0.3/0.1 = 2.9999999996
 * does not silently become 2 steps instead of 3.
 */
export function roundDownToStep(qty: number, step: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isFinite(step) || step <= 0) return qty;
  const steps = Math.floor(qty / step + 1e-9);
  const out = steps * step;
  return Number(out.toFixed(precisionOf(step)));
}

/** Round a price to the PRICE_FILTER tick size (nearest tick). */
export function roundToTick(price: number, tick: number): number {
  if (!Number.isFinite(tick) || tick <= 0) return price;
  return Number((Math.round(price / tick) * tick).toFixed(precisionOf(tick)));
}

export type CandidateInputs = {
  state: PortfolioState;
  exchangeInfo: ExchangeInfo;
  /** Keyed by base asset symbol */
  books: Record<string, OrderBook>;
  cashSymbol: string;
  config?: PlanConfig;
  /** Restrict to these base symbols (used for PARTIAL execution) */
  onlySymbols?: string[];
};

export type CandidateResult = {
  candidates: CandidateTrade[];
  /** Why a drifting symbol produced no trade — surfaced in the UI, not hidden */
  skipped: { symbol: string; reason: string }[];
};

export function generateCandidates(input: CandidateInputs): CandidateResult {
  const config = input.config ?? DEFAULT_PLAN_CONFIG;
  const { state, exchangeInfo, books, cashSymbol } = input;
  const only = input.onlySymbols ? new Set(input.onlySymbols) : null;

  const skipped: { symbol: string; reason: string }[] = [];
  const raw: Omit<CandidateTrade, "id" | "sequenceIndex">[] = [];

  for (const row of state.rows) {
    // Cash is the quote leg; it is never traded against itself. Its drift is
    // resolved implicitly by the other legs.
    if (row.symbol === cashSymbol) continue;
    if (only && !only.has(row.symbol)) continue;
    if (!row.outsideBand) continue;

    const deltaUsd = row.deltaUsd;
    const side: Side = deltaUsd > 0 ? "BUY" : "SELL";

    // Step 1 — dust filter
    if (Math.abs(deltaUsd) < config.minTradeUsd) {
      skipped.push({
        symbol: row.symbol,
        reason: `Delta $${Math.abs(deltaUsd).toFixed(2)} is below the $${config.minTradeUsd} minimum trade size.`,
      });
      continue;
    }

    const pair = `${row.symbol}${cashSymbol}`;
    const filters = exchangeInfo.symbols[pair];
    if (!filters) {
      skipped.push({ symbol: row.symbol, reason: `No tradable pair ${pair} on the exchange.` });
      continue;
    }
    if (filters.status !== "TRADING") {
      skipped.push({ symbol: row.symbol, reason: `${pair} is not currently trading (${filters.status}).` });
      continue;
    }

    const book = books[row.symbol];
    if (!book || (book.bids.length === 0 && book.asks.length === 0)) {
      skipped.push({ symbol: row.symbol, reason: `No order book depth available for ${pair}.` });
      continue;
    }

    const mid = midPrice(book);
    if (mid <= 0) {
      skipped.push({ symbol: row.symbol, reason: `No usable price for ${pair}.` });
      continue;
    }

    // Step 2 — exchange filters. Size from mid, then round DOWN to stepSize.
    const rawQty = Math.abs(deltaUsd) / mid;
    let qty = roundDownToStep(rawQty, filters.stepSize);

    if (qty < filters.minQty || qty <= 0) {
      skipped.push({
        symbol: row.symbol,
        reason: `Quantity ${rawQty.toFixed(8)} rounds below the ${pair} minimum lot (${filters.minQty}).`,
      });
      continue;
    }

    // A SELL cannot exceed what we actually hold.
    if (side === "SELL") {
      // The balance itself, not a value divided by a different price base.
      const held = row.qty;
      if (qty > held) qty = roundDownToStep(held, filters.stepSize);
      if (qty <= 0) {
        skipped.push({ symbol: row.symbol, reason: `Nothing to sell in ${row.symbol}.` });
        continue;
      }
    }

    let walk = walkBookByQty(book, side, qty);

    // A trade the book cannot fill must never be sized as if it could.
    //
    // walkBookByQty computes vwap from the part that *did* fill, and this used
    // to multiply it by the full quantity — full size at a partial price. The
    // slippage figure counted only the filled portion too, so the unfillable
    // remainder was free. Both errors point the same way: on an illiquid asset
    // the cost came out optimistic, which corrupts costPerPpUsd, the number the
    // timing call leans on hardest. The one case where cost should stop a trade
    // was the case where cost was wrong.
    if (walk.exhausted && walk.filledQty > 0) {
      const fillable = roundDownToStep(walk.filledQty, filters.stepSize);
      if (fillable < filters.minQty || fillable <= 0) {
        skipped.push({
          symbol: row.symbol,
          reason: `The ${pair} book cannot fill even the minimum size right now.`,
        });
        continue;
      }
      skipped.push({
        symbol: row.symbol,
        reason:
          `The ${pair} book runs out before ${qty} ${row.symbol}; sized down to ${fillable} ` +
          `and the rest left for later.`,
      });
      qty = fillable;
      walk = walkBookByQty(book, side, qty);
    }

    const estNotionalUsd = qty * walk.vwap;

    // MIN_NOTIONAL is checked after rounding, per DESIGN.md §5.4 step 2.
    if (estNotionalUsd < filters.minNotional) {
      skipped.push({
        symbol: row.symbol,
        reason: `Notional $${estNotionalUsd.toFixed(2)} falls below the ${pair} minimum of $${filters.minNotional}.`,
      });
      continue;
    }

    raw.push({
      side,
      symbol: row.symbol,
      pair,
      qty,
      estNotionalUsd,
      estFeeUsd: estNotionalUsd * config.feeRate,
      estSlippageUsd: walk.slippageUsd,
      estExecPrice: roundToTick(walk.vwap, filters.tickSize),
      midPrice: mid,
      slippageBps: walk.slippageBps,
      bookExhausted: walk.exhausted,
    });
  }

  // Step 3 — sells before buys; buys need the quote currency that sells produce.
  // Within a side, act on the largest notional first.
  const sells = raw.filter((t) => t.side === "SELL").sort((a, b) => b.estNotionalUsd - a.estNotionalUsd);
  const buys = raw.filter((t) => t.side === "BUY").sort((a, b) => b.estNotionalUsd - a.estNotionalUsd);

  const candidates: CandidateTrade[] = [...sells, ...buys].map((t, i) => ({
    ...t,
    id: `t${i + 1}`,
    sequenceIndex: i,
  }));

  return { candidates, skipped };
}

/**
 * Net USD change per symbol if the given trades execute.
 * BUY increases the asset's value, SELL decreases it.
 */
export function deltasFromTrades(trades: CandidateTrade[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of trades) {
    const signed = t.side === "BUY" ? t.estNotionalUsd : -t.estNotionalUsd;
    out[t.symbol] = (out[t.symbol] ?? 0) + signed;
  }
  return out;
}
