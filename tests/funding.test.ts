import { describe, expect, it } from "vitest";

import { applyFundingLimit } from "../src/core/funding";
import { syntheticBook } from "../src/core/slippage";
import type { ExchangeInfo, OrderedTrade } from "../src/types";

function filters(pair: string, base: string, over: Partial<ExchangeInfo["symbols"][string]> = {}) {
  return {
    pair,
    baseAsset: base,
    quoteAsset: "USDT",
    stepSize: 0.00001,
    minQty: 0.00001,
    tickSize: 0.01,
    minNotional: 10,
    status: "TRADING",
    ...over,
  };
}

const exchangeInfo: ExchangeInfo = {
  symbols: {
    BTCUSDT: filters("BTCUSDT", "BTC"),
    ETHUSDT: filters("ETHUSDT", "ETH"),
    SOLUSDT: filters("SOLUSDT", "SOL", { stepSize: 0.001, minQty: 0.001 }),
  },
};

const books = {
  BTC: syntheticBook("BTCUSDT", 100_000),
  ETH: syntheticBook("ETHUSDT", 4_000),
  SOL: syntheticBook("SOLUSDT", 200),
};

function leg(
  side: "BUY" | "SELL",
  symbol: string,
  qty: number,
  price: number,
  i = 0,
): OrderedTrade {
  const notional = qty * price;
  return {
    id: `t${i}`,
    side,
    symbol,
    pair: `${symbol}USDT`,
    qty,
    estNotionalUsd: notional,
    estFeeUsd: notional * 0.001,
    estSlippageUsd: notional * 0.0002,
    estExecPrice: price,
    midPrice: price,
    slippageBps: 2,
    sequenceIndex: i,
    bookExhausted: false,
    method: "spot_market",
    limitPriceOffsetBps: 0,
    why: "test",
  };
}

const base = { feeRate: 0.001, exchangeInfo, books };

describe("buys are funded before they are sent", () => {
  it("leaves a self-funding plan alone", () => {
    const trades = [leg("SELL", "BTC", 0.1, 100_000, 0), leg("BUY", "ETH", 2.4, 4_000, 1)];
    const r = applyFundingLimit({ ...base, trades, cashUsd: 1_000 });
    expect(r.scaled).toBe(false);
    expect(r.trades).toEqual(trades);
  });

  it("scales buys down when the funding sell was dropped", () => {
    // The failure the review found: the sell is gone — skipped by a filter, or
    // dropped by the execution model, which the prompt invites — and the buy
    // keeps its full size. Binance then rejects it for insufficient balance,
    // at the confirmation step.
    const trades = [leg("BUY", "ETH", 2.5, 4_000)]; // wants $10,000 + fee
    const r = applyFundingLimit({ ...base, trades, cashUsd: 5_000 });

    expect(r.scaled).toBe(true);
    expect(r.availableCashUsd).toBe(5_000);
    const cost = r.trades[0].estNotionalUsd + r.trades[0].estFeeUsd;
    expect(cost).toBeLessThanOrEqual(5_000);
    // ...and it is still a real trade, not a token one.
    expect(cost).toBeGreaterThan(4_000);
  });

  it("counts sell proceeds net of their fee, not gross", () => {
    // $10,000 of sells raises $9,990 after the 10bps fee. A plan sized against
    // the gross figure is short by exactly the fee.
    const trades = [leg("SELL", "BTC", 0.1, 100_000, 0), leg("BUY", "ETH", 2.5, 4_000, 1)];
    const r = applyFundingLimit({ ...base, trades, cashUsd: 0 });
    expect(r.availableCashUsd).toBeCloseTo(9_990, 2);
    expect(r.scaled).toBe(true);
    const buy = r.trades.find((t) => t.side === "BUY")!;
    expect(buy.estNotionalUsd + buy.estFeeUsd).toBeLessThanOrEqual(9_990);
  });

  it("splits a short budget across buys in proportion", () => {
    const trades = [leg("BUY", "ETH", 2, 4_000, 0), leg("BUY", "SOL", 20, 200, 1)];
    // Asks for $8,000 + $4,000; only half is available.
    const r = applyFundingLimit({ ...base, trades, cashUsd: 6_000 });
    const eth = r.trades.find((t) => t.symbol === "ETH")!;
    const sol = r.trades.find((t) => t.symbol === "SOL")!;
    expect(eth.estNotionalUsd / sol.estNotionalUsd).toBeCloseTo(2, 1);
    expect(r.trades.reduce((s, t) => s + t.estNotionalUsd + t.estFeeUsd, 0)).toBeLessThanOrEqual(6_000);
  });

  it("drops a leg that scales below the exchange minimum rather than sending it", () => {
    const trades = [leg("BUY", "ETH", 2, 4_000, 0), leg("BUY", "SOL", 20, 200, 1)];
    // Almost nothing available: both scale to dust.
    const r = applyFundingLimit({ ...base, trades, cashUsd: 12 });
    expect(r.trades.length).toBeLessThan(2);
    expect(r.adjustments.some((a) => a.toQty === null)).toBe(true);
  });

  it("re-prices a scaled leg instead of keeping the original estimate", () => {
    // A smaller order walks fewer levels, so carrying the old slippage forward
    // would overstate what the scaled plan costs.
    const trades = [leg("BUY", "ETH", 10, 4_000)];
    const r = applyFundingLimit({ ...base, trades, cashUsd: 8_000 });
    const buy = r.trades[0];
    expect(buy.qty).toBeLessThan(10);
    expect(buy.estSlippageUsd).toBeLessThan(trades[0].estSlippageUsd);
  });

  it("never touches the sells — they are what raises the cash", () => {
    const trades = [leg("SELL", "BTC", 0.1, 100_000, 0), leg("BUY", "ETH", 5, 4_000, 1)];
    const r = applyFundingLimit({ ...base, trades, cashUsd: 0 });
    const sell = r.trades.find((t) => t.side === "SELL")!;
    expect(sell.qty).toBe(0.1);
  });

  it("keeps sells before buys after resizing", () => {
    const trades = [leg("SELL", "BTC", 0.1, 100_000, 0), leg("BUY", "ETH", 5, 4_000, 1)];
    const r = applyFundingLimit({ ...base, trades, cashUsd: 0 });
    const sides = r.trades.map((t) => t.side);
    expect(sides.indexOf("SELL")).toBeLessThan(sides.indexOf("BUY"));
    expect(r.trades.map((t) => t.sequenceIndex)).toEqual([0, 1]);
  });

  it("reports what it changed rather than doing it silently", () => {
    const r = applyFundingLimit({ ...base, trades: [leg("BUY", "ETH", 5, 4_000)], cashUsd: 5_000 });
    expect(r.adjustments).toHaveLength(1);
    expect(r.adjustments[0].symbol).toBe("ETH");
    expect(r.adjustments[0].fromQty).toBe(5);
    expect(r.adjustments[0].toQty).toBeLessThan(5);
  });

  it("does nothing when there is nothing to buy", () => {
    const trades = [leg("SELL", "BTC", 0.1, 100_000)];
    const r = applyFundingLimit({ ...base, trades, cashUsd: 0 });
    expect(r.scaled).toBe(false);
    expect(r.trades).toEqual(trades);
  });
});
