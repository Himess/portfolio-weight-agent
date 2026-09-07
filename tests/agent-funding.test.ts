import { describe, expect, it } from "vitest";

import { runReview } from "../src/agent";
import { syntheticBook } from "../src/core/slippage";
import type { MarketAdapter } from "../src/adapters/types";
import type { Allocation, ExchangeInfo, Kline, OrderBook } from "../src/types";

/**
 * The funding bug, through the real agent rather than the unit under it.
 *
 * `generateCandidates` sizes each leg from its own deltaUsd, and the deltas sum
 * to zero including cash — so a complete plan funds itself. The guarantee dies
 * the moment one leg does not survive, and the most ordinary way for that to
 * happen is an exchange filter: a pair that is halted, or a sell too small to
 * place. The buys keep their full size, the cash was never there, and Binance
 * rejects the order at the confirmation step.
 *
 * `deterministicOnly` keeps the model out of it: this is about arithmetic that
 * has to hold whether or not a judgment layer is available.
 */

const PRICES: Record<string, number> = { BTC: 100_000, ETH: 4_000, USDT: 1 };

function market(exchangeInfo: ExchangeInfo): MarketAdapter {
  return {
    async getPrices(symbols: string[]) {
      return Object.fromEntries(symbols.map((s: string) => [s, PRICES[s] ?? 0]));
    },
    async getKlines(): Promise<Kline[]> {
      return [];
    },
    async getOrderBook(symbol: string): Promise<OrderBook> {
      return syntheticBook(`${symbol}USDT`, PRICES[symbol] ?? 1);
    },
    async getExchangeInfo() {
      return exchangeInfo;
    },
  };
}

function filters(pair: string, base: string, over: Record<string, unknown> = {}) {
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
  } as ExchangeInfo["symbols"][string];
}

const allocation: Allocation = {
  cashSymbol: "USDT",
  targets: [
    { kind: "asset", symbol: "BTC", weight: 0.4 },
    { kind: "asset", symbol: "ETH", weight: 0.4 },
    { kind: "asset", symbol: "USDT", weight: 0.2 },
  ],
};

// BTC far overweight, ETH far under, almost no cash: the buy has to be paid for
// by the sell.
const quantities = { BTC: 0.8, ETH: 1, USDT: 100 };

function affordability(trades: { side: string; estNotionalUsd: number; estFeeUsd: number }[], cash: number) {
  const proceeds = trades
    .filter((t) => t.side === "SELL")
    .reduce((s, t) => s + t.estNotionalUsd - t.estFeeUsd, 0);
  const cost = trades
    .filter((t) => t.side === "BUY")
    .reduce((s, t) => s + t.estNotionalUsd + t.estFeeUsd, 0);
  return { available: cash + proceeds, cost };
}

describe("the plan is always payable", () => {
  it("funds itself when every leg survives", async () => {
    const info: ExchangeInfo = {
      symbols: { BTCUSDT: filters("BTCUSDT", "BTC"), ETHUSDT: filters("ETHUSDT", "ETH") },
    };
    const p = await runReview({
      market: market(info),
      allocation,
      quantities,
      preference: "balanced",
      daysSinceLastRebalance: null,
      deterministicOnly: true,
    });

    const { available, cost } = affordability(p.orderedTrades, 100);
    expect(p.orderedTrades.length).toBeGreaterThan(0);
    expect(cost).toBeLessThanOrEqual(available + 0.01);
    expect(p.funding).toBeUndefined(); // nothing needed scaling
  });

  it("scales the buy when the sell that funds it is filtered out", async () => {
    // BTCUSDT halted: the SELL never becomes a candidate, and the BUY used to
    // keep its full size against $100 of cash.
    const info: ExchangeInfo = {
      symbols: {
        BTCUSDT: filters("BTCUSDT", "BTC", { status: "HALT" }),
        ETHUSDT: filters("ETHUSDT", "ETH"),
      },
    };
    const p = await runReview({
      market: market(info),
      allocation,
      quantities,
      preference: "balanced",
      daysSinceLastRebalance: null,
      deterministicOnly: true,
    });

    const { available, cost } = affordability(p.orderedTrades, 100);
    expect(p.orderedTrades.every((t) => t.side === "BUY")).toBe(true);
    expect(cost).toBeLessThanOrEqual(available + 0.01);
    // ...and it says it had to, rather than quietly sending a smaller order.
    expect(p.funding).toBeDefined();
    expect(p.funding!.adjustments.length).toBeGreaterThan(0);
  });

  it("holds rather than proposing a plan it cannot pay for at all", async () => {
    // No cash and no sellable leg: there is nothing to fund a buy with, so the
    // scaled leg falls under the exchange minimum and the plan empties. An
    // empty plan is a hold, not a rebalance with nothing in it.
    const info: ExchangeInfo = {
      symbols: {
        BTCUSDT: filters("BTCUSDT", "BTC", { status: "HALT" }),
        ETHUSDT: filters("ETHUSDT", "ETH", { minNotional: 5_000 }),
      },
    };
    const p = await runReview({
      market: market(info),
      allocation,
      quantities: { BTC: 0.8, ETH: 1, USDT: 20 },
      preference: "balanced",
      daysSinceLastRebalance: null,
      deterministicOnly: true,
    });

    expect(p.orderedTrades).toHaveLength(0);
    expect(p.timing.action).toBe("HOLD");
    // And the prose does not read "The plan is . That removes 0.0pp".
    expect(p.narrative).not.toMatch(/plan is \./);
    expect(p.narrative.length).toBeGreaterThan(20);
  });
});
