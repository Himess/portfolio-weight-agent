import { describe, expect, it } from "vitest";

import { assess, findConfusable, liquidityTier } from "../src/lib/safety";

/**
 * The real hazards of picking an asset on a CEX: mistaking a ticker for a
 * bigger one that shares its letters, and buying something too thin to trade.
 */

// Volumes are the shape of a real Binance day: a few giants, a long tail.
const UNIVERSE = [
  { symbol: "BTC", quoteVolume24hUsd: 700_000_000 },
  { symbol: "ETH", quoteVolume24hUsd: 485_000_000 },
  { symbol: "SOL", quoteVolume24hUsd: 274_000_000 },
  { symbol: "BNB", quoteVolume24hUsd: 136_000_000 },
  { symbol: "SOLV", quoteVolume24hUsd: 3_000_000 },
  { symbol: "BNSOL", quoteVolume24hUsd: 900_000 },
  { symbol: "ETHFI", quoteVolume24hUsd: 12_000_000 },
  { symbol: "OP", quoteVolume24hUsd: 40_000_000 },
  { symbol: "ARB", quoteVolume24hUsd: 45_000_000 },
  { symbol: "ARK", quoteVolume24hUsd: 2_000_000 },
  { symbol: "DUST", quoteVolume24hUsd: 40_000 },
];

describe("liquidity tiers", () => {
  it("grades by 24h quote volume", () => {
    expect(liquidityTier(700_000_000)).toBe("deep");
    expect(liquidityTier(12_000_000)).toBe("ok");
    expect(liquidityTier(900_000)).toBe("thin");
    expect(liquidityTier(40_000)).toBe("very-thin");
  });

  it("treats missing or zero volume as the worst case, not the best", () => {
    expect(liquidityTier(0)).toBe("very-thin");
    expect(liquidityTier(Number.NaN)).toBe("very-thin");
  });
});

describe("ticker confusion", () => {
  it("flags a small symbol that contains a much larger one", () => {
    // The case that actually appeared in the picker's own search results.
    expect(findConfusable("SOLV", UNIVERSE)).toContain("SOL");
    expect(findConfusable("BNSOL", UNIVERSE)).toContain("SOL");
    expect(findConfusable("ETHFI", UNIVERSE)).toContain("ETH");
  });

  it("does not flag the dominant symbol itself", () => {
    expect(findConfusable("SOL", UNIVERSE)).toEqual([]);
    expect(findConfusable("BTC", UNIVERSE)).toEqual([]);
  });

  it("does not flag symbols that merely share letters", () => {
    // ARK and ARB are comparable, unrelated names — neither contains the other.
    expect(findConfusable("ARK", UNIVERSE)).toEqual([]);
    expect(findConfusable("ARB", UNIVERSE)).toEqual([]);
  });

  it("requires a large volume gap, not just a substring", () => {
    const close = [
      { symbol: "SOL", quoteVolume24hUsd: 10_000_000 },
      { symbol: "SOLV", quoteVolume24hUsd: 9_000_000 },
    ];
    // Comparable size: sharing letters is not by itself a trap.
    expect(findConfusable("SOLV", close)).toEqual([]);
  });

  it("ignores very short tickers, which share letters with everything", () => {
    const withShort = [...UNIVERSE, { symbol: "OM", quoteVolume24hUsd: 1_000 }];
    expect(findConfusable("OM", withShort)).toEqual([]);
  });

  it("returns nothing for a symbol outside the universe", () => {
    expect(findConfusable("NOTLISTED", UNIVERSE)).toEqual([]);
  });
});

describe("combined assessment", () => {
  it("says nothing about a deep, unambiguous market", () => {
    const s = assess("BTC", 700_000_000, UNIVERSE);
    expect(s.tier).toBe("deep");
    expect(s.isLookalike).toBe(false);
    expect(s.notes).toEqual([]);
  });

  it("warns on both counts when both apply", () => {
    const s = assess("BNSOL", 900_000, UNIVERSE);
    expect(s.tier).toBe("thin");
    expect(s.isLookalike).toBe(true);
    expect(s.notes).toHaveLength(2);
    expect(s.notes.join(" ")).toMatch(/SOL/);
  });

  it("warns on liquidity alone for an obscure but unambiguous name", () => {
    const s = assess("DUST", 40_000, UNIVERSE);
    expect(s.tier).toBe("very-thin");
    expect(s.isLookalike).toBe(false);
    expect(s.notes).toHaveLength(1);
  });
});
