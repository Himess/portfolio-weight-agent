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
import { midPrice, walkBookByQty } from "./slippage";

export const DEFAULT_PLAN_CONFIG: PlanConfig = {
  bands: { absoluteFloorPp: 2.0, relativeBandPct: 0.25 },
  minTradeUsd: 10,
  feeRate: 0.001, // 10 bps taker, Binance spot default tier
};

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
      const held = row.currentValueUsd / mid;
      if (qty > held) qty = roundDownToStep(held, filters.stepSize);
      if (qty <= 0) {
        skipped.push({ symbol: row.symbol, reason: `Nothing to sell in ${row.symbol}.` });
        continue;
      }
    }

    const walk = walkBookByQty(book, side, qty);
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
