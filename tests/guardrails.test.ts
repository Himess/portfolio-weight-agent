import { describe, expect, it } from "vitest";

import { generateCandidates } from "../src/core/candidates";
import { buildHoldings, computeDrift } from "../src/core/drift";
import { computeCostBenefit } from "../src/core/costbenefit";
import { syntheticBook } from "../src/core/slippage";
import { deterministicExecution, materializeTrades } from "../src/llm/execution";
import { findBareFigures, substitute } from "../src/llm/narrative";
import { deterministicTiming } from "../src/llm/timing";
import type { Allocation, ExchangeInfo, RebalanceContext } from "../src/types";

/**
 * These test the boundary the whole product rests on: the LLM selects and
 * explains, and is structurally prevented from computing. Every one of these
 * is exercised without an API key.
 */

const alloc: Allocation = {
  cashSymbol: "USDT",
  targets: [
    { kind: "asset", symbol: "BTC", weight: 0.5 },
    { kind: "asset", symbol: "AVAX", weight: 0.4 },
    { kind: "asset", symbol: "USDT", weight: 0.1 },
  ],
};

const exchangeInfo: ExchangeInfo = {
  symbols: {
    BTCUSDT: { pair: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", stepSize: 0.00001, minQty: 0.00001, tickSize: 0.01, minNotional: 5, status: "TRADING" },
    AVAXUSDT: { pair: "AVAXUSDT", baseAsset: "AVAX", quoteAsset: "USDT", stepSize: 0.01, minQty: 0.01, tickSize: 0.001, minNotional: 5, status: "TRADING" },
  },
};

function makeContext(avaxPrice: number): RebalanceContext {
  const prices = { BTC: 100_000, AVAX: avaxPrice };
  const holdings = buildHoldings({ BTC: 0.5, AVAX: 4000, USDT: 10_000 }, prices, "USDT");
  const portfolio = computeDrift(holdings, alloc);
  const books = {
    BTC: syntheticBook("BTCUSDT", prices.BTC),
    AVAX: syntheticBook("AVAXUSDT", prices.AVAX),
  };
  const { candidates } = generateCandidates({ state: portfolio, exchangeInfo, books, cashSymbol: "USDT" });
  return {
    asOf: new Date().toISOString(),
    portfolio,
    candidates,
    costBenefit: computeCostBenefit(portfolio, candidates),
    signals: [],
    daysSinceLastRebalance: 30,
    preference: "balanced",
    cashSymbol: "USDT",
  };
}

describe("timing fallback", () => {
  it("HOLDs and explains the aggregate-vs-band distinction when nothing is outside band", () => {
    const ctx = makeContext(10); // on target
    const d = deterministicTiming(ctx, "test");
    expect(d.action).toBe("HOLD");
    expect(d.assetsToActOn).toEqual([]);
    expect(d.fellBack).toBe(true);
    // The reasoning must explain why a non-zero total drift still means no trade,
    // otherwise the number and the verdict look contradictory.
    expect(d.reasoning).toMatch(/tolerance band/i);
  });

  it("REBALANCEs every outside-band position, and labels itself a fallback", () => {
    const ctx = makeContext(4); // AVAX halved -> well outside band
    const d = deterministicTiming(ctx, "no credentials");
    expect(d.action).toBe("REBALANCE");
    expect(d.assetsToActOn).toContain("AVAX");
    expect(d.assetsToActOn).not.toContain("USDT"); // cash is never traded
    expect(d.fellBack).toBe(true);
    expect(d.fallbackReason).toBe("no credentials");
  });
});

describe("execution guardrails — the LLM cannot invent or resize a trade", () => {
  const ctx = makeContext(4);

  it("takes quantities from the deterministic candidate, ignoring any model-supplied size", () => {
    const c = ctx.candidates[0];
    const materialized = materializeTrades(
      {
        orderedTrades: [
          // A model trying to change the size has nowhere to put it: the shape
          // only carries a candidateId, and qty is read from our own record.
          { candidateId: c.id, method: "spot_limit", limitPriceOffsetBps: 12, why: "x" },
        ],
        droppedCandidates: [],
      },
      ctx.candidates,
    );
    expect(materialized).toHaveLength(1);
    expect(materialized[0].qty).toBe(c.qty);
    expect(materialized[0].estNotionalUsd).toBe(c.estNotionalUsd);
    expect(materialized[0].method).toBe("spot_limit");
  });

  it("silently drops a hallucinated candidate id rather than fabricating a trade", () => {
    const materialized = materializeTrades(
      {
        orderedTrades: [
          { candidateId: "t999", method: "spot_market", limitPriceOffsetBps: 0, why: "invented" },
        ],
        droppedCandidates: [],
      },
      ctx.candidates,
    );
    expect(materialized).toHaveLength(0);
  });

  it("falls back to market orders for every candidate", () => {
    const d = deterministicExecution(ctx.candidates, "test");
    expect(d.orderedTrades).toHaveLength(ctx.candidates.length);
    expect(d.orderedTrades.every((t) => t.method === "spot_market")).toBe(true);
    expect(d.fellBack).toBe(true);
  });
});

describe("narrative guardrails — figures are substituted, never retyped", () => {
  it("catches a money figure the model typed itself", () => {
    expect(findBareFigures("This costs $42.10 to run")).toContain("$42.10");
    expect(findBareFigures("Drift fell 3.2%")).toContain("3.2%");
    expect(findBareFigures("about 12.5pp of drift")).toContain("12.5pp");
    expect(findBareFigures("a 30 bps cost")).toContain("30 bps");
  });

  it("allows figures that arrive as placeholders", () => {
    expect(findBareFigures("This costs {{EST_COST}} and removes {{DRIFT_REDUCTION}}")).toHaveLength(0);
  });

  it("allows ordinary small counts in words or bare integers", () => {
    expect(findBareFigures("Selling both positions across 2 legs")).toHaveLength(0);
  });

  it("substitutes known placeholders and reports unknown ones", () => {
    const { out, unknown } = substitute("Cost {{EST_COST}}, drift {{NOPE}}", {
      EST_COST: "$5.72",
    });
    expect(out).toContain("$5.72");
    expect(unknown).toEqual(["NOPE"]);
  });
});
