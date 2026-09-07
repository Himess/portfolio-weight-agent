import { describe, expect, it } from "vitest";

import { ExplainFactsSchema } from "../src/lib/api-contracts";
import { explainFactsFrom } from "../src/lib/explain-facts";
import { claimsExecution, deterministicExplain, explainTokens } from "../src/llm/explain";
import { findBareFigures, substitute, unnamedAssets } from "../src/llm/narrative";
import type { Proposal } from "../src/types";

/**
 * The explain surface answers "why didn't you sell AVAX?" from the fact sheet
 * the verdict was made from. Two properties matter and neither is about prose:
 *
 *   - it can only quote figures that are in the digest, so an answer cannot
 *     mention a price, a position or a cost the decision never saw;
 *   - a PARTIAL has to be answerable per leg, which means the digest has to
 *     carry what each position did, not just the verdict.
 */

const proposal = {
  context: {
    cashSymbol: "USDT",
    daysSinceLastRebalance: 11,
    portfolio: {
      navUsd: 107_119.35,
      totalDriftPp: 4.86,
      asOf: "2025-10-11T00:00:00.000Z",
      rows: [
        {
          symbol: "AVAX",
          targetWeight: 0.15,
          currentWeight: 0.1986,
          driftPp: 4.86,
          deltaUsd: -5202.39,
          outsideBand: true,
          bandPp: 1.23,
          targetValueUsd: 16_067.9,
          currentValueUsd: 21_270.29,
        },
        {
          symbol: "BTC",
          targetWeight: 0.4,
          currentWeight: 0.3785,
          driftPp: -2.15,
          deltaUsd: 2305.68,
          outsideBand: true,
          bandPp: 0.9,
          targetValueUsd: 42_847.74,
          currentValueUsd: 40_542.06,
        },
        {
          symbol: "USDT",
          targetWeight: 0.1,
          currentWeight: 0.0934,
          driftPp: -0.66,
          deltaUsd: 711.94,
          outsideBand: false,
          bandPp: 0.7,
          targetValueUsd: 10_711.94,
          currentValueUsd: 10_000,
        },
      ],
    },
    signals: [
      { symbol: "AVAX", realizedVol24h: 1.8, realizedVol4h: 4.0, volRatio: 2.23, priceChange4hPct: -15.18, priceChange24hPct: -21.4 },
      { symbol: "BTC", realizedVol24h: 0.9, realizedVol4h: 1.0, volRatio: 1.12, priceChange4hPct: -0.28, priceChange24hPct: -1.1 },
    ],
    costBenefit: {
      estimatedCostUsd: 5.67,
      driftReductionPp: 2.15,
      costPerPpUsd: 2.64,
      costBps: 1.4,
      totalDriftAfterPp: 2.71,
    },
  },
  timing: {
    action: "PARTIAL",
    primaryFactor: "falling_knife",
    reasoning: "AVAX is dropping sharply and the move is still running.",
    assetsToActOn: ["BTC"],
    confidence: 0.7,
  },
  execution: null,
  orderedTrades: [
    {
      id: "t0",
      side: "BUY",
      symbol: "BTC",
      pair: "BTCUSDT",
      qty: 0.0231,
      estNotionalUsd: 2305.68,
      estFeeUsd: 2.31,
      estSlippageUsd: 0.4,
      estExecPrice: 99_812.5,
      midPrice: 99_800,
      slippageBps: 1.3,
      sequenceIndex: 0,
      bookExhausted: false,
      method: "spot_market",
      limitPriceOffsetBps: 0,
      why: "underweight",
    },
  ],
  declined: [
    { side: "SELL", symbol: "AVAX", pair: "AVAXUSDT", qty: 180.5, estNotionalUsd: 3626.6, why: "falling knife" },
  ],
  narrative: "",
} as unknown as Proposal;

describe("the decision, reduced to what a question can be answered from", () => {
  const facts = explainFactsFrom(proposal);

  it("produces a digest the wire contract accepts", () => {
    expect(() => ExplainFactsSchema.parse(facts)).not.toThrow();
  });

  it("records what each position did, not just the verdict", () => {
    // PARTIAL alone cannot answer "why didn't you sell AVAX?" — the answer is
    // per leg, so the per-leg outcome has to survive the projection.
    const avax = facts.rows.find((r) => r.symbol === "AVAX")!;
    const btc = facts.rows.find((r) => r.symbol === "BTC")!;
    expect(avax.declined).toBe(true);
    expect(avax.actedOn).toBe(false);
    expect(btc.actedOn).toBe(true);
    expect(btc.declined).toBe(false);
  });

  it("carries volRatio, which is the whole reason this leg was declined", () => {
    expect(facts.rows.find((r) => r.symbol === "AVAX")!.volRatio).toBe(2.23);
    expect(explainTokens(facts).AVAX_VOL_RATIO).toBe("2.23");
  });

  it("drops cash — it has no signals and is never a leg", () => {
    expect(facts.rows.map((r) => r.symbol)).not.toContain("USDT");
  });
});

describe("an answer can only contain figures the decision had", () => {
  const facts = explainFactsFrom(proposal);
  const tokens = explainTokens(facts);

  it("offers a placeholder for every position it kept", () => {
    for (const r of facts.rows) {
      expect(tokens[`${r.symbol}_DRIFT`]).toBeDefined();
      expect(tokens[`${r.symbol}_BAND`]).toBeDefined();
    }
  });

  it("has no placeholder for a position that was not in the decision", () => {
    // The bound that matters: there is no token to substitute, so a claim about
    // SOL cannot acquire a number, whatever the model writes.
    expect(Object.keys(tokens).some((k) => k.startsWith("SOL_"))).toBe(false);
  });

  it("leaves a made-up placeholder unresolved rather than guessing", () => {
    const { unknown } = substitute("SOL moved {{SOL_DRIFT}}", tokens);
    expect(unknown).toEqual(["SOL_DRIFT"]);
  });

  it("substitutes real figures into placeholder prose", () => {
    const { out, unknown } = substitute("AVAX drifted {{AVAX_DRIFT}} against a {{AVAX_BAND}} band.", tokens);
    expect(unknown).toHaveLength(0);
    expect(out).toBe("AVAX drifted 4.86pp against a 1.23pp band.");
  });

  it("still catches a figure typed straight into an answer", () => {
    // Same guard as the narrative layer, applied to answers.
    expect(findBareFigures("AVAX fell 15.2% in four hours").length).toBeGreaterThan(0);
    expect(findBareFigures("AVAX fell {{AVAX_CHANGE_4H}} in four hours")).toHaveLength(0);
  });

  it("still catches figures quoted for an asset that is never named", () => {
    expect(unnamedAssets("the move was {{AVAX_CHANGE_4H}}", ["AVAX", "BTC"])).toEqual(["AVAX"]);
    expect(unnamedAssets("AVAX moved {{AVAX_CHANGE_4H}}", ["AVAX", "BTC"])).toEqual([]);
  });
});

describe("an answer may never claim an order happened", () => {
  it("catches the sentence the live run actually produced", () => {
    // Verbatim from the first end-to-end run: every figure correct, and the
    // claim false — the plan was on screen awaiting approval in Binance.
    expect(
      claimsExecution("You sold SOL because it crossed its tolerance band with a drift of 14.95pp."),
    ).toEqual(["sold"]);
  });

  it("catches the other ways of saying it", () => {
    expect(claimsExecution("BTC was bought to close the gap")).toEqual(["bought"]);
    expect(claimsExecution("the portfolio has been rebalanced")).toEqual(["rebalanced"]);
    expect(claimsExecution("the order filled at the mid")).toEqual(["filled"]);
  });

  it("leaves the correct phrasing alone", () => {
    // Present tense about a proposal is exactly what the prompt asks for.
    expect(claimsExecution("the plan sells SOL and buys BTC")).toEqual([]);
    expect(claimsExecution("it proposes trimming SOL; AVAX was left out")).toEqual([]);
    // ...and a word that merely contains one of the verbs is not one of them.
    expect(claimsExecution("SOL trades thinly, so the plan uses a limit order")).toEqual([]);
    expect(claimsExecution("unsold inventory")).toEqual([]);
  });
});

describe("the answer with no model available", () => {
  const facts = explainFactsFrom(proposal);

  it("says what happened to each position rather than apologising", () => {
    const out = deterministicExplain(facts);
    expect(out).toContain("PARTIAL");
    expect(out).toContain("falling knife"); // underscores unwrapped for reading
    expect(out).toMatch(/AVAX breached its band and was left out/);
    expect(out).toMatch(/BTC is in the plan/);
  });

  it("types no figure it did not compute", () => {
    // It is allowed real figures — it built them — but they must come from the
    // digest, so every one it prints has to appear there.
    const out = deterministicExplain(facts);
    expect(out).toContain("4.86pp");
    expect(out).toContain("1.23pp");
  });

  it("never says a trade happened — nothing has been approved yet", () => {
    // The product's one hard boundary: it proposes, the owner approves in
    // Binance. Prose in the past tense claims an execution that did not occur.
    const out = deterministicExplain(facts);
    expect(out).not.toMatch(/(sold|bought|traded|executed|rebalanced)/i);
  });

  it("does not claim a breach when nothing breached", () => {
    const calm = {
      ...facts,
      verdict: "HOLD" as const,
      rows: facts.rows.map((r) => ({ ...r, outsideBand: false, actedOn: false, declined: false })),
    };
    expect(deterministicExplain(calm)).toContain("every position inside its band");
  });
});
