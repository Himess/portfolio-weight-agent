/**
 * Can these buys actually be paid for?
 *
 * Nothing checked. Candidate generation sizes each leg from its own
 * `deltaUsd`, and the sum of every delta including cash is zero, so a full plan
 * funds itself by construction. That guarantee holds only while *every* leg
 * survives, and three ordinary paths break it:
 *
 *   - a SELL is skipped by an exchange filter — dust, minNotional, no book,
 *     a pair that is not TRADING — while the BUYs keep their full size;
 *   - the execution model drops a SELL, which the prompt explicitly invites
 *     ("drop a candidate when its cost is out of proportion");
 *   - PARTIAL, where `assetsToActOn` can contain only underweight symbols, so
 *     candidates are regenerated as buys alone and the funding is expected to
 *     come entirely from cash that may not be there.
 *
 * The failure lands at the worst possible moment: Binance rejects the order
 * for insufficient balance, at the confirmation step, in front of the user.
 *
 * So this is arithmetic, done here, after the execution decision and after any
 * drop. The model is never asked whether a plan is affordable — it was already
 * handed `availableCashUsd` and nothing enforced it.
 */

import { roundDownToStep } from "./candidates";
import { walkBookByQty } from "./slippage";
import type { ExchangeInfo, OrderBook, OrderedTrade } from "../types";

export type FundingAdjustment = {
  symbol: string;
  fromQty: number;
  toQty: number | null;
  reason: string;
};

export type FundingResult = {
  trades: OrderedTrade[];
  /** Cash on hand plus what the surviving sells will actually raise, net of fees. */
  availableCashUsd: number;
  /** What the buys asked for, including their fees. */
  requestedUsd: number;
  scaled: boolean;
  adjustments: FundingAdjustment[];
};

export type FundingInput = {
  trades: OrderedTrade[];
  /** Cash currently held, in quote units. */
  cashUsd: number;
  feeRate: number;
  exchangeInfo: ExchangeInfo;
  /** Books for re-pricing a leg that gets resized; absent means keep the estimate. */
  books: Record<string, OrderBook>;
};

/** A buy costs its notional plus the fee on it; a sell raises notional less the fee. */
const costOf = (t: OrderedTrade) => t.estNotionalUsd + t.estFeeUsd;
const proceedsOf = (t: OrderedTrade) => t.estNotionalUsd - t.estFeeUsd;

export function applyFundingLimit(input: FundingInput): FundingResult {
  const { trades, cashUsd, feeRate, exchangeInfo, books } = input;

  const sells = trades.filter((t) => t.side === "SELL");
  const buys = trades.filter((t) => t.side === "BUY");

  const availableCashUsd = cashUsd + sells.reduce((sum, t) => sum + proceedsOf(t), 0);
  const requestedUsd = buys.reduce((sum, t) => sum + costOf(t), 0);

  const unchanged: FundingResult = {
    trades,
    availableCashUsd,
    requestedUsd,
    scaled: false,
    adjustments: [],
  };

  if (buys.length === 0 || requestedUsd <= availableCashUsd) return unchanged;

  // Leave a hair of headroom: the fill price is an estimate from the book walk,
  // and a plan sized to the last cent fails on a one-tick move.
  const budget = availableCashUsd * 0.999;
  const scale = budget / requestedUsd;

  const adjustments: FundingAdjustment[] = [];
  const resized: OrderedTrade[] = [];

  for (const t of buys) {
    const filters = exchangeInfo.symbols[t.pair];
    const target = t.qty * scale;
    const qty = filters ? roundDownToStep(target, filters.stepSize) : target;

    if (filters && (qty < filters.minQty || qty <= 0)) {
      adjustments.push({
        symbol: t.symbol,
        fromQty: t.qty,
        toQty: null,
        reason: `Scaled to ${qty} ${t.symbol}, below the ${t.pair} minimum size — dropped.`,
      });
      continue;
    }

    // Re-price against the book: a smaller order walks fewer levels, so keeping
    // the original slippage would overstate what the scaled plan costs.
    const book = books[t.symbol];
    const walk = book ? walkBookByQty(book, "BUY", qty) : null;
    const estExecPrice = walk ? walk.vwap : t.estExecPrice;
    const estNotionalUsd = qty * estExecPrice;

    if (filters && estNotionalUsd < filters.minNotional) {
      adjustments.push({
        symbol: t.symbol,
        fromQty: t.qty,
        toQty: null,
        reason: `Scaled to $${estNotionalUsd.toFixed(2)}, below the ${t.pair} minimum notional — dropped.`,
      });
      continue;
    }

    adjustments.push({
      symbol: t.symbol,
      fromQty: t.qty,
      toQty: qty,
      reason: `Scaled to fit the cash the sells actually raise.`,
    });

    resized.push({
      ...t,
      qty,
      estNotionalUsd,
      estFeeUsd: estNotionalUsd * feeRate,
      estSlippageUsd: walk ? walk.slippageUsd : t.estSlippageUsd * scale,
      estExecPrice,
      slippageBps: walk ? walk.slippageBps : t.slippageBps,
      bookExhausted: walk ? walk.exhausted : t.bookExhausted,
    });
  }

  // Sells keep their order and their sizes: they are what raises the cash.
  const out = [...sells, ...resized].map((t, i) => ({ ...t, sequenceIndex: i }));

  return {
    trades: out,
    availableCashUsd,
    requestedUsd,
    scaled: true,
    adjustments,
  };
}
