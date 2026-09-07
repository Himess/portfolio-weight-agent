import { describe, expect, it } from "vitest";

import { generateCandidates } from "../src/core/candidates";
import { buildHoldings, computeDrift } from "../src/core/drift";
import { computeCostBenefit } from "../src/core/costbenefit";
import { syntheticBook } from "../src/core/slippage";
import { deterministicExecution, materializeTrades } from "../src/llm/execution";
import { claimedSidesNotInPlan, findBareFigures, substitute, unnamedAssets } from "../src/llm/narrative";
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

describe("narrative formatting", () => {
  it("preserves the blank line between headline and body", () => {
    // The UI splits on "\n\n"; collapsing it with a generic \s rule ran the
    // headline into the body on screen.
    const { out } = substitute("Holding steady\n\nDrift sits at {{D}}.", { D: "4.9pp" });
    expect(out.split("\n\n")).toHaveLength(2);
    expect(out.split("\n\n")[0]).toBe("Holding steady");
    expect(out.split("\n\n")[1]).toBe("Drift sits at 4.9pp.");
  });

  it("still collapses runs of spaces left by a removed placeholder", () => {
    const { out } = substitute("a  b", {});
    expect(out).toBe("a b");
  });
});

describe("a placeholder cannot stand in for an asset's name", () => {
  const symbols = ["BTC", "ETH", "AVAX", "USDT"];

  it("catches the substitution that reads as a number where a name belongs", () => {
    // Caught in a real run: "movement in {{AVAX_CURRENT}}" substitutes to
    // "movement in 19.9%" — every token resolved, no bare figure was typed,
    // and the sentence was still nonsense.
    const raw = "Holding steady\n\nDrift is {{TOTAL_DRIFT}}, led by strong movement in {{AVAX_CURRENT}}.";
    expect(unnamedAssets(raw, symbols)).toEqual(["AVAX"]);
  });

  it("passes prose that names the asset whose figures it quotes", () => {
    const raw = "Trim AVAX\n\nAVAX sits {{AVAX_DRIFT}} above its {{AVAX_TARGET}} target.";
    expect(unnamedAssets(raw, symbols)).toEqual([]);
  });

  it("does not accept the ticker inside its own placeholder as naming it", () => {
    expect(unnamedAssets("Head\n\nOne position sits at {{BTC_CURRENT}}.", symbols)).toEqual(["BTC"]);
  });

  it("ignores assets whose figures are never quoted", () => {
    expect(unnamedAssets("Head\n\nETH is fine; total drift is {{TOTAL_DRIFT}}.", symbols)).toEqual([]);
  });

  it("accepts a ticker in possessive or punctuated form", () => {
    const raw = "Head\n\nETH's weight is {{ETH_CURRENT}}, and BTC, at {{BTC_CURRENT}}, is fine.";
    expect(unnamedAssets(raw, symbols)).toEqual([]);
  });
});

describe("the prose cannot describe trades the plan does not contain", () => {
  const symbols = ["BTC", "ETH", "SOL", "AVAX", "USDT"];
  const sells = [
    { symbol: "BTC", side: "SELL" as const },
    { symbol: "ETH", side: "SELL" as const },
  ];

  it("catches the contradiction that shipped", () => {
    // Live on the deployed site: two SELL legs, no buys, and prose promising
    // to buy the two assets the data source could not even price.
    const text = "Selling what went up allows us to buy SOL and AVAX.";
    expect(claimedSidesNotInPlan(text, sells, symbols)).toEqual(["BUY AVAX", "BUY SOL"]);
  });

  it("passes prose that matches the plan", () => {
    const text = "We are selling BTC and ETH to bring both back to target.";
    expect(claimedSidesNotInPlan(text, sells, symbols)).toEqual([]);
  });

  it("attributes a symbol to the nearest side word, not to every one", () => {
    // Both sides appear; SOL belongs to "buy", which is adjacent.
    const plan = [
      { symbol: "BTC", side: "SELL" as const },
      { symbol: "SOL", side: "BUY" as const },
    ];
    const text = "Selling BTC after its run lets us buy SOL while it is down.";
    expect(claimedSidesNotInPlan(text, plan, symbols)).toEqual([]);
  });

  it("does not read 'reduces your total drift' as selling something", () => {
    // A real narrative. "reduce" is not in the verb list precisely because of
    // this sentence, and no symbol sits near a side word anyway.
    const text = "This disciplined sale of winners reduces your total drift.";
    expect(claimedSidesNotInPlan(text, sells, symbols)).toEqual([]);
  });

  it("ignores a negated claim", () => {
    const text = "We are not buying SOL today.";
    expect(claimedSidesNotInPlan(text, sells, symbols)).toEqual([]);
  });

  it("says nothing about a HOLD, where there is no plan to contradict", () => {
    const text = "AVAX has drifted but the move is still running, so we are waiting.";
    expect(claimedSidesNotInPlan(text, [], symbols)).toEqual([]);
  });

  it("does not fire on a ticker embedded in a longer one", () => {
    const plan = [{ symbol: "BNSOL", side: "BUY" as const }];
    const text = "We are buying BNSOL.";
    expect(claimedSidesNotInPlan(text, plan, ["SOL", "BNSOL"])).toEqual([]);
  });
});

describe("the figure guard covers order sizes", () => {
  it("catches a quantity next to a ticker", () => {
    // The class it missed entirely. Nothing rejected this, and the README
    // claimed no invented figure reaches the user.
    expect(findBareFigures("We are selling 1.08 ETH today.").length).toBeGreaterThan(0);
    expect(findBareFigures("Buying 0.16758 BTC now.").length).toBeGreaterThan(0);
  });

  it("catches a quantity after a side verb", () => {
    expect(findBareFigures("sell 12 of them").length).toBeGreaterThan(0);
    expect(findBareFigures("buy 3.5 more").length).toBeGreaterThan(0);
  });

  it("catches any decimal precise enough to be a size", () => {
    // Prices and percentages here are written to two places. Three or more is
    // a quantity, whatever it sits next to.
    expect(findBareFigures("the figure was 0.16758")).toContain("0.16758");
  });

  it("still ignores placeholders, which is the whole point", () => {
    const raw =
      "Trimming {{AVAX_QTY}} AVAX for {{AVAX_NOTIONAL}}, cutting drift by {{DRIFT_REDUCTION}}.";
    expect(findBareFigures(raw)).toEqual([]);
  });

  it("does not fire on ordinary prose or small counts", () => {
    expect(findBareFigures("Both positions have crossed their bands.")).toEqual([]);
    expect(findBareFigures("Three legs, sells before buys.")).toEqual([]);
    expect(findBareFigures("AVAX is still running hot, so we are waiting.")).toEqual([]);
  });
});
