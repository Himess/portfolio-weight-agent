/**
 * Order book walk — DESIGN.md §5.4.
 *
 * "Walk live order book levels until cumulative notional covers the trade;
 * report the volume-weighted execution price versus mid."
 *
 * This number is the main input to the "is this worth doing" question, so it is
 * computed from real depth rather than assumed to be a flat percentage.
 */

import type { OrderBook, Side } from "../types";

export type BookWalk = {
  /** Volume-weighted average execution price across consumed levels */
  vwap: number;
  midPrice: number;
  filledQty: number;
  filledNotional: number;
  /** Signed bps vs mid; positive always means worse for the taker */
  slippageBps: number;
  /** Absolute USD cost of crossing the spread and walking depth */
  slippageUsd: number;
  /** True when the book ran out before the full size was covered */
  exhausted: boolean;
};

export function midPrice(book: OrderBook): number {
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  if (bestBid != null && bestAsk != null) return (bestBid + bestAsk) / 2;
  return bestBid ?? bestAsk ?? 0;
}

/**
 * Walk the book for a given base-asset quantity.
 * BUY consumes asks (ascending), SELL consumes bids (descending).
 */
export function walkBookByQty(book: OrderBook, side: Side, qty: number): BookWalk {
  const mid = midPrice(book);
  const levels = side === "BUY" ? book.asks : book.bids;

  if (qty <= 0 || levels.length === 0 || mid <= 0) {
    return {
      vwap: mid,
      midPrice: mid,
      filledQty: 0,
      filledNotional: 0,
      slippageBps: 0,
      slippageUsd: 0,
      exhausted: levels.length === 0,
    };
  }

  let remaining = qty;
  let notional = 0;
  let filled = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.qty);
    notional += take * level.price;
    filled += take;
    remaining -= take;
  }

  const exhausted = remaining > 1e-12;
  const vwap = filled > 0 ? notional / filled : mid;

  // Positive bps = worse for the taker, on both sides.
  const rawBps = ((vwap - mid) / mid) * 10_000;
  const slippageBps = side === "BUY" ? rawBps : -rawBps;
  const slippageUsd = Math.abs(vwap - mid) * filled;

  return {
    vwap,
    midPrice: mid,
    filledQty: filled,
    filledNotional: notional,
    slippageBps,
    slippageUsd,
    exhausted,
  };
}

/**
 * Walk the book to cover a target quote-currency notional.
 * Used when sizing from a USD delta rather than a quantity.
 */
export function walkBookByNotional(
  book: OrderBook,
  side: Side,
  targetNotional: number,
): BookWalk {
  const mid = midPrice(book);
  if (mid <= 0 || targetNotional <= 0) {
    return {
      vwap: mid,
      midPrice: mid,
      filledQty: 0,
      filledNotional: 0,
      slippageBps: 0,
      slippageUsd: 0,
      exhausted: false,
    };
  }
  // First pass at mid, then refine against actual depth.
  const approxQty = targetNotional / mid;
  return walkBookByQty(book, side, approxQty);
}

/**
 * A synthetic book, used by the replay adapter where real depth is not
 * available. Depth is modelled as a fixed spread plus linear impact so that
 * larger trades cost more — the ordering property the timing decision needs.
 */
export function syntheticBook(
  symbol: string,
  price: number,
  opts: { spreadBps?: number; depthUsdPerLevel?: number; levels?: number } = {},
): OrderBook {
  const spreadBps = opts.spreadBps ?? 4;
  const depthUsd = opts.depthUsdPerLevel ?? 25_000;
  const levels = opts.levels ?? 40;
  const half = (price * spreadBps) / 2 / 10_000;

  const bids = [];
  const asks = [];
  for (let i = 0; i < levels; i++) {
    // Each level steps 2bps further out and carries depthUsd of size.
    const step = (price * 2 * i) / 10_000;
    const bidPrice = price - half - step;
    const askPrice = price + half + step;
    bids.push({ price: bidPrice, qty: depthUsd / bidPrice });
    asks.push({ price: askPrice, qty: depthUsd / askPrice });
  }
  return { symbol, bids, asks };
}
