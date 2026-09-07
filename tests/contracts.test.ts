import { describe, expect, it } from "vitest";

import {
  AllocationSchema,
  ExplainRequestSchema,
  McpTokenRequestSchema,
  ReviewRequestSchema,
  SparksQuerySchema,
  TokensQuerySchema,
  firstIssue,
} from "../src/lib/api-contracts";

/**
 * The API boundary. These routes are the only place untrusted input enters, so
 * what they accept is worth pinning down — everything below them is written on
 * the assumption that this passed.
 */

const leaf = (symbol: string, weight: number) => ({ kind: "asset" as const, symbol, weight });

const validReview = {
  allocation: { targets: [leaf("BTC", 0.6), leaf("USDT", 0.4)], cashSymbol: "USDT" },
  quantities: { BTC: 1 },
  source: "public" as const,
};

describe("allocation shape", () => {
  it("accepts a well-formed allocation and normalises symbol case", () => {
    const parsed = AllocationSchema.parse({
      targets: [leaf("btc", 0.6), leaf("usdt", 0.4)],
      cashSymbol: "usdt",
    });
    expect(parsed.targets[0]).toMatchObject({ symbol: "BTC" });
    expect(parsed.cashSymbol).toBe("USDT");
  });

  it("rejects a symbol that could reach into a URL path", () => {
    // Symbols are interpolated into upstream URLs, so this is not cosmetic.
    for (const bad of ["BTC/../x", "BTC USDT", "../etc", "<script>", "BTC?x=1"]) {
      expect(() => AllocationSchema.parse({ targets: [leaf(bad, 1)], cashSymbol: "USDT" })).toThrow();
    }
  });

  it("rejects a weight outside 0..1", () => {
    expect(() => AllocationSchema.parse({ targets: [leaf("BTC", 5)], cashSymbol: "USDT" })).toThrow();
    expect(() => AllocationSchema.parse({ targets: [leaf("BTC", -1)], cashSymbol: "USDT" })).toThrow();
    expect(() => AllocationSchema.parse({ targets: [leaf("BTC", Number.NaN)], cashSymbol: "USDT" })).toThrow();
  });

  it("rejects an unknown target kind rather than ignoring it", () => {
    expect(() =>
      AllocationSchema.parse({ targets: [{ kind: "wat", symbol: "BTC", weight: 1 }], cashSymbol: "USDT" }),
    ).toThrow();
  });

  it("caps the number of legs", () => {
    // Each leg costs upstream market-data calls; an unbounded list is a way to
    // make this app hammer Binance on someone else's behalf.
    const many = Array.from({ length: 60 }, (_, i) => leaf(`SYM${i}`, 1 / 60));
    expect(() => AllocationSchema.parse({ targets: many, cashSymbol: "USDT" })).toThrow();
  });

  it("requires a basket to have members and a resolution timestamp", () => {
    const basket = {
      kind: "basket" as const,
      label: "L1s",
      weight: 1,
      members: [],
      resolvedAt: "2026-01-01T00:00:00.000Z",
      rationale: "x",
    };
    expect(() => AllocationSchema.parse({ targets: [basket], cashSymbol: "USDT" })).toThrow();
    expect(() =>
      AllocationSchema.parse({
        targets: [{ ...basket, members: [{ symbol: "SOL", weight: 1 }], resolvedAt: "" }],
        cashSymbol: "USDT",
      }),
    ).toThrow();
  });
});

describe("review request", () => {
  it("accepts the happy path and applies defaults", () => {
    const parsed = ReviewRequestSchema.parse(validReview);
    expect(parsed.preference).toBe("balanced");
    expect(parsed.daysSinceLastRebalance).toBeNull();
  });

  it("refuses live mode without holdings, naming the field", () => {
    const { quantities: _drop, ...noHoldings } = validReview;
    const result = ReviewRequestSchema.safeParse(noHoldings);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(firstIssue(result.error)).toMatch(/quantities/);
      expect(firstIssue(result.error)).toMatch(/holdings/i);
    }
  });

  it("allows replay mode without holdings, because it seeds its own", () => {
    const { quantities: _drop, ...rest } = validReview;
    expect(() => ReviewRequestSchema.parse({ ...rest, source: "replay", seedBar: 30, bar: 400 })).not.toThrow();
  });

  it("rejects a negative quantity", () => {
    expect(() =>
      ReviewRequestSchema.parse({ ...validReview, quantities: { BTC: -1 } }),
    ).toThrow();
  });

  it("rejects an unknown preference instead of silently defaulting", () => {
    expect(() => ReviewRequestSchema.parse({ ...validReview, preference: "aggressive" })).toThrow();
  });

  it("rejects a nonsensical staleness value", () => {
    expect(() =>
      ReviewRequestSchema.parse({ ...validReview, daysSinceLastRebalance: -5 }),
    ).toThrow();
  });
});

describe("query params clamp rather than reject", () => {
  it("caps an oversized limit at the maximum", () => {
    expect(TokensQuerySchema.parse({ limit: "99999" }).limit).toBe(500);
  });

  it("floors a tiny or zero limit at one", () => {
    expect(TokensQuerySchema.parse({ limit: "0" }).limit).toBe(250);
    expect(TokensQuerySchema.parse({ limit: "-4" }).limit).toBe(1);
  });

  it("falls back to the default for nonsense", () => {
    expect(TokensQuerySchema.parse({ limit: "abc" }).limit).toBe(250);
    expect(TokensQuerySchema.parse({}).limit).toBe(250);
  });

  it("drops symbols that are not plain tickers, keeping the rest", () => {
    const { symbols } = SparksQuerySchema.parse({ symbols: "BTC,../etc/passwd,ETH,<script>" });
    expect(symbols).toEqual(["BTC", "ETH"]);
  });

  it("de-duplicates and caps the batch", () => {
    const many = Array.from({ length: 40 }, (_, i) => `SYM${i}`).join(",");
    expect(SparksQuerySchema.parse({ symbols: `BTC,BTC,${many}` }).symbols.length).toBe(14);
  });
});

describe("mcp token", () => {
  it("rejects something too short to be a token before any network call", () => {
    expect(() => McpTokenRequestSchema.parse({ token: "abc" })).toThrow();
  });

  it("accepts a plausible one and trims it", () => {
    const parsed = McpTokenRequestSchema.parse({ token: "  " + "a".repeat(40) + "  " });
    expect(parsed.token).toHaveLength(40);
  });
});

describe("a question about a decision", () => {
  const facts = {
    verdict: "PARTIAL" as const,
    primaryFactor: "falling_knife",
    reasoning: "AVAX is still falling.",
    navUsd: 100_000,
    totalDriftPp: 4.86,
    daysSinceLastRebalance: 11,
    costBenefit: { estimatedCostUsd: 5.67, driftReductionPp: 2.15, costPerPpUsd: 2.64 },
    rows: [
      {
        symbol: "AVAX",
        targetWeight: 0.15,
        currentWeight: 0.2,
        driftPp: 4.86,
        bandPp: 1.23,
        deltaUsd: -5202,
        outsideBand: true,
        actedOn: false,
        declined: true,
        priceChange4hPct: -15.18,
        priceChange24hPct: -21.4,
        volRatio: 2.23,
      },
    ],
    trades: [],
  };

  it("accepts a question about a decision that exists", () => {
    expect(ExplainRequestSchema.parse({ question: "why not AVAX?", facts }).facts.rows).toHaveLength(1);
  });

  it("will not take a question with no decision attached", () => {
    // Without facts there is nothing to answer from, and an answer invented to
    // fill the gap is the one thing this surface must not produce.
    expect(() => ExplainRequestSchema.parse({ question: "why not AVAX?" })).toThrow();
  });

  it("rejects an empty question rather than answering a blank", () => {
    expect(() => ExplainRequestSchema.parse({ question: "   ", facts })).toThrow();
  });

  it("caps the question, so the box is not a channel for a prompt", () => {
    expect(() => ExplainRequestSchema.parse({ question: "a".repeat(401), facts })).toThrow();
  });

  it("carries no allocation, so a question cannot reach the portfolio", () => {
    const parsed = ExplainRequestSchema.parse({
      question: "why not AVAX?",
      facts,
      allocation: { targets: [leaf("BTC", 1)], cashSymbol: "USDT" },
    });
    expect(parsed).not.toHaveProperty("allocation");
  });

  it("rejects a verdict it does not recognise", () => {
    expect(() =>
      ExplainRequestSchema.parse({ question: "why?", facts: { ...facts, verdict: "SELL_EVERYTHING" } }),
    ).toThrow();
  });
});
