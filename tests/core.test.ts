import { describe, expect, it } from "vitest";

import {
  allocationSymbols,
  flattenTargets,
  normalizeMemberWeights,
  validateAllocation,
} from "../src/core/allocation";
import {
  DEFAULT_PLAN_CONFIG,
  deltasFromTrades,
  generateCandidates,
  precisionOf,
  roundDownToStep,
  roundToTick,
} from "../src/core/candidates";
import { computeCostBenefit } from "../src/core/costbenefit";
import { bandFor, buildHoldings, computeDrift, computeNav } from "../src/core/drift";
import { computeSignals, isMoveInProgress, logReturns, stdev } from "../src/core/signals";
import { midPrice, syntheticBook, walkBookByQty } from "../src/core/slippage";
import type { Allocation, ExchangeInfo, Kline, OrderBook } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const alloc: Allocation = {
  cashSymbol: "USDT",
  targets: [
    { kind: "asset", symbol: "BTC", weight: 0.4 },
    { kind: "asset", symbol: "ETH", weight: 0.2 },
    {
      kind: "basket",
      label: "L1s",
      weight: 0.3,
      members: [
        { symbol: "SOL", weight: 0.5 },
        { symbol: "AVAX", weight: 0.5 },
      ],
      resolvedAt: "2026-09-06T00:00:00.000Z",
      rationale: "test",
    },
    { kind: "asset", symbol: "USDT", weight: 0.1 },
  ],
};

function filters(pair: string, base: string, over: Partial<ExchangeInfo["symbols"][string]> = {}) {
  return {
    pair,
    baseAsset: base,
    quoteAsset: "USDT",
    stepSize: 0.00001,
    minQty: 0.00001,
    tickSize: 0.01,
    minNotional: 5,
    status: "TRADING",
    ...over,
  };
}

const exchangeInfo: ExchangeInfo = {
  symbols: {
    BTCUSDT: filters("BTCUSDT", "BTC"),
    ETHUSDT: filters("ETHUSDT", "ETH"),
    SOLUSDT: filters("SOLUSDT", "SOL", { stepSize: 0.001 }),
    AVAXUSDT: filters("AVAXUSDT", "AVAX", { stepSize: 0.01 }),
  },
};

const prices = { BTC: 100_000, ETH: 4_000, SOL: 200, AVAX: 40 };

function books(): Record<string, OrderBook> {
  return {
    BTC: syntheticBook("BTCUSDT", prices.BTC),
    ETH: syntheticBook("ETHUSDT", prices.ETH),
    SOL: syntheticBook("SOLUSDT", prices.SOL),
    AVAX: syntheticBook("AVAXUSDT", prices.AVAX),
  };
}

// ---------------------------------------------------------------------------
// §4 — allocation invariants
// ---------------------------------------------------------------------------

describe("allocation", () => {
  it("accepts a well-formed allocation summing to 1.0", () => {
    expect(validateAllocation(alloc)).toEqual({ ok: true });
  });

  it("rejects weights that do not sum to 1.0", () => {
    const bad: Allocation = {
      cashSymbol: "USDT",
      targets: [
        { kind: "asset", symbol: "BTC", weight: 0.5 },
        { kind: "asset", symbol: "ETH", weight: 0.3 },
      ],
    };
    const res = validateAllocation(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/sum to 1\.0/);
  });

  it("rejects a basket whose members do not sum to 1.0", () => {
    const bad: Allocation = {
      cashSymbol: "USDT",
      targets: [
        {
          kind: "basket",
          label: "L1s",
          weight: 1,
          members: [
            { symbol: "SOL", weight: 0.5 },
            { symbol: "AVAX", weight: 0.2 },
          ],
          resolvedAt: "x",
          rationale: "y",
        },
      ],
    };
    const res = validateAllocation(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/member weights/);
  });

  it("rejects a symbol appearing in both a leaf and a basket", () => {
    const bad: Allocation = {
      cashSymbol: "USDT",
      targets: [
        { kind: "asset", symbol: "SOL", weight: 0.5 },
        {
          kind: "basket",
          label: "L1s",
          weight: 0.5,
          members: [{ symbol: "SOL", weight: 1 }],
          resolvedAt: "x",
          rationale: "y",
        },
      ],
    };
    const res = validateAllocation(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/more than once/);
  });

  it("flattens basket members against the basket weight", () => {
    const flat = flattenTargets(alloc);
    expect(flat.BTC).toBeCloseTo(0.4, 10);
    expect(flat.SOL).toBeCloseTo(0.15, 10);
    expect(flat.AVAX).toBeCloseTo(0.15, 10);
    // The flattened weights must still sum to 1.
    const sum = Object.values(flat).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("lists every symbol including basket members", () => {
    expect(allocationSymbols(alloc).sort()).toEqual(
      ["AVAX", "BTC", "ETH", "SOL", "USDT"].sort(),
    );
  });

  it("normalizes near-1 member weights but rejects wildly wrong ones", () => {
    const near = normalizeMemberWeights([
      { symbol: "A", weight: 0.34 },
      { symbol: "B", weight: 0.33 },
      { symbol: "C", weight: 0.34 },
    ]);
    expect(near).not.toBeNull();
    expect(near!.reduce((a, m) => a + m.weight, 0)).toBeCloseTo(1, 10);

    expect(
      normalizeMemberWeights([
        { symbol: "A", weight: 0.5 },
        { symbol: "B", weight: 0.9 },
      ]),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §5.1–5.3 — NAV, drift, bands
// ---------------------------------------------------------------------------

describe("nav and drift", () => {
  it("computes NAV with cash at 1.0", () => {
    const holdings = buildHoldings({ BTC: 1, USDT: 5_000 }, prices, "USDT");
    expect(computeNav(holdings)).toBe(105_000);
  });

  it("reports zero drift for an on-target portfolio", () => {
    // NAV 100k split exactly 40/20/15/15/10
    const holdings = buildHoldings(
      { BTC: 0.4, ETH: 5, SOL: 75, AVAX: 375, USDT: 10_000 },
      prices,
      "USDT",
    );
    const state = computeDrift(holdings, alloc);
    expect(state.navUsd).toBeCloseTo(100_000, 6);
    expect(state.totalDriftPp).toBeCloseTo(0, 9);
    expect(state.rows.every((r) => !r.outsideBand)).toBe(true);
  });

  it("halves summed absolute drift — over- and under-weights mirror each other", () => {
    // ETH doubled in value: 5 ETH at 8000 instead of 4000.
    const state = computeDrift(
      buildHoldings({ BTC: 0.4, ETH: 5, SOL: 75, AVAX: 375, USDT: 10_000 }, { ...prices, ETH: 8_000 }, "USDT"),
      alloc,
    );
    const summed = state.rows.reduce((s, r) => s + Math.abs(r.driftPp), 0);
    expect(state.totalDriftPp).toBeCloseTo(summed / 2, 9);

    // And the signed drifts must cancel — that is why halving is correct.
    const signed = state.rows.reduce((s, r) => s + r.driftPp, 0);
    expect(signed).toBeCloseTo(0, 8);
  });

  it("applies relative bands above the floor and the floor below it", () => {
    expect(bandFor(0.4, DEFAULT_PLAN_CONFIG.bands)).toBeCloseTo(10, 10); // 0.25 * 40
    expect(bandFor(0.05, DEFAULT_PLAN_CONFIG.bands)).toBeCloseTo(2, 10); // floor wins
  });

  it("treats unallocated holdings as drift against a zero target", () => {
    const holdings = buildHoldings({ BTC: 0.4, DOGE: 10_000 }, { ...prices, DOGE: 1 }, "USDT");
    const state = computeDrift(holdings, alloc);
    const doge = state.rows.find((r) => r.symbol === "DOGE")!;
    expect(doge.targetWeight).toBe(0);
    expect(doge.driftPp).toBeGreaterThan(0);
    expect(doge.deltaUsd).toBeLessThan(0); // must be sold
  });

  it("does not produce NaN on an empty portfolio", () => {
    const state = computeDrift([], alloc);
    expect(state.navUsd).toBe(0);
    expect(Number.isNaN(state.totalDriftPp)).toBe(false);
    expect(state.rows.every((r) => Number.isFinite(r.driftPp))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §5.4 — exchange filters and candidate generation
// ---------------------------------------------------------------------------

describe("exchange filter arithmetic", () => {
  it("derives precision from a step size", () => {
    expect(precisionOf(0.001)).toBe(3);
    expect(precisionOf(1)).toBe(0);
    expect(precisionOf(0.00000001)).toBe(8);
  });

  it("rounds down, never up", () => {
    expect(roundDownToStep(1.999, 0.1)).toBeCloseTo(1.9, 10);
    expect(roundDownToStep(0.05, 0.1)).toBe(0);
  });

  it("survives binary floating-point representation error", () => {
    // 0.3 / 0.1 is 2.9999999999999996 in IEEE-754; a naive floor gives 0.2.
    expect(roundDownToStep(0.3, 0.1)).toBeCloseTo(0.3, 10);
    expect(roundDownToStep(0.7, 0.1)).toBeCloseTo(0.7, 10);
    expect(roundDownToStep(1.1, 0.1)).toBeCloseTo(1.1, 10);
  });

  it("rounds prices to the nearest tick", () => {
    expect(roundToTick(100.007, 0.01)).toBeCloseTo(100.01, 10);
    expect(roundToTick(100.004, 0.01)).toBeCloseTo(100.0, 10);
  });
});

describe("candidate generation", () => {
  // ETH doubles -> overweight ETH, everything else underweight.
  const drifted = computeDrift(
    buildHoldings({ BTC: 0.4, ETH: 5, SOL: 75, AVAX: 375, USDT: 10_000 }, { ...prices, ETH: 8_000 }, "USDT"),
    alloc,
  );

  it("sequences every sell before every buy", () => {
    const { candidates } = generateCandidates({
      state: drifted,
      exchangeInfo,
      books: { ...books(), ETH: syntheticBook("ETHUSDT", 8_000) },
      cashSymbol: "USDT",
    });
    expect(candidates.length).toBeGreaterThan(0);
    const firstBuy = candidates.findIndex((c) => c.side === "BUY");
    const lastSell = candidates.map((c) => c.side).lastIndexOf("SELL");
    if (firstBuy >= 0 && lastSell >= 0) expect(lastSell).toBeLessThan(firstBuy);
    // sequenceIndex must be dense and ordered
    candidates.forEach((c, i) => expect(c.sequenceIndex).toBe(i));
  });

  it("never emits a trade for the cash symbol", () => {
    const { candidates } = generateCandidates({
      state: drifted,
      exchangeInfo,
      books: { ...books(), ETH: syntheticBook("ETHUSDT", 8_000) },
      cashSymbol: "USDT",
    });
    expect(candidates.some((c) => c.symbol === "USDT")).toBe(false);
  });

  it("drops dust below the minimum trade size, with a stated reason", () => {
    const tiny = computeDrift(
      buildHoldings({ BTC: 0.4, ETH: 5.0001, SOL: 75, AVAX: 375, USDT: 10_000 }, prices, "USDT"),
      alloc,
    );
    const { candidates, skipped } = generateCandidates({
      state: tiny,
      exchangeInfo,
      books: books(),
      cashSymbol: "USDT",
      config: { ...DEFAULT_PLAN_CONFIG, minTradeUsd: 10_000 },
    });
    expect(candidates).toHaveLength(0);
    // Anything outside its band that produced no trade must explain itself.
    const outside = tiny.rows.filter((r) => r.outsideBand && r.symbol !== "USDT");
    expect(skipped.length).toBe(outside.length);
  });

  it("drops trades that fall under MIN_NOTIONAL after rounding", () => {
    const info: ExchangeInfo = {
      symbols: { ...exchangeInfo.symbols, ETHUSDT: filters("ETHUSDT", "ETH", { minNotional: 1e9 }) },
    };
    const { candidates, skipped } = generateCandidates({
      state: drifted,
      exchangeInfo: info,
      books: { ...books(), ETH: syntheticBook("ETHUSDT", 8_000) },
      cashSymbol: "USDT",
    });
    expect(candidates.some((c) => c.symbol === "ETH")).toBe(false);
    expect(skipped.some((s) => s.symbol === "ETH" && /minimum/.test(s.reason))).toBe(true);
  });

  it("skips a symbol with no tradable pair rather than inventing one", () => {
    const info: ExchangeInfo = { symbols: { BTCUSDT: exchangeInfo.symbols.BTCUSDT } };
    const { candidates, skipped } = generateCandidates({
      state: drifted,
      exchangeInfo: info,
      books: { ...books(), ETH: syntheticBook("ETHUSDT", 8_000) },
      cashSymbol: "USDT",
    });
    expect(candidates.every((c) => c.pair === "BTCUSDT")).toBe(true);
    expect(skipped.some((s) => /No tradable pair/.test(s.reason))).toBe(true);
  });

  it("never sells more of an asset than is held", () => {
    const { candidates } = generateCandidates({
      state: drifted,
      exchangeInfo,
      books: { ...books(), ETH: syntheticBook("ETHUSDT", 8_000) },
      cashSymbol: "USDT",
    });
    const ethSell = candidates.find((c) => c.symbol === "ETH" && c.side === "SELL");
    if (ethSell) expect(ethSell.qty).toBeLessThanOrEqual(5);
  });

  it("honours onlySymbols, for PARTIAL execution", () => {
    const { candidates } = generateCandidates({
      state: drifted,
      exchangeInfo,
      books: { ...books(), ETH: syntheticBook("ETHUSDT", 8_000) },
      cashSymbol: "USDT",
      onlySymbols: ["ETH"],
    });
    expect(candidates.every((c) => c.symbol === "ETH")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Order book walk
// ---------------------------------------------------------------------------

describe("order book walk", () => {
  const book = syntheticBook("BTCUSDT", 100_000);

  it("computes a mid between best bid and ask", () => {
    expect(midPrice(book)).toBeCloseTo(100_000, 2);
  });

  it("reports positive slippage bps for both sides", () => {
    const buy = walkBookByQty(book, "BUY", 0.5);
    const sell = walkBookByQty(book, "SELL", 0.5);
    expect(buy.slippageBps).toBeGreaterThan(0);
    expect(sell.slippageBps).toBeGreaterThan(0);
    expect(buy.vwap).toBeGreaterThan(buy.midPrice);
    expect(sell.vwap).toBeLessThan(sell.midPrice);
  });

  it("charges more for larger size", () => {
    const small = walkBookByQty(book, "BUY", 0.05);
    const large = walkBookByQty(book, "BUY", 5);
    expect(large.slippageBps).toBeGreaterThan(small.slippageBps);
  });

  it("flags an exhausted book instead of pretending to fill", () => {
    const thin: OrderBook = { symbol: "X", bids: [], asks: [{ price: 100, qty: 1 }] };
    const walk = walkBookByQty(thin, "BUY", 1000);
    expect(walk.exhausted).toBe(true);
    expect(walk.filledQty).toBe(1);
  });

  it("returns finite values for an empty book", () => {
    const walk = walkBookByQty({ symbol: "X", bids: [], asks: [] }, "BUY", 1);
    expect(Number.isFinite(walk.vwap)).toBe(true);
    expect(walk.exhausted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §6 — signals and cost/benefit
// ---------------------------------------------------------------------------

describe("signals", () => {
  const mkKlines = (closes: number[]): Kline[] =>
    closes.map((c, i) => ({
      openTime: i * 3_600_000,
      open: c,
      high: c,
      low: c,
      close: c,
      volume: 1,
      closeTime: (i + 1) * 3_600_000,
      quoteVolume: c,
    }));

  it("computes sample stdev", () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(stdev([1])).toBe(0);
  });

  it("computes one fewer return than closes", () => {
    expect(logReturns([100, 110, 121])).toHaveLength(2);
  });

  it("reports a high vol ratio when the market turns disorderly", () => {
    // 20 calm hours, then five violent hours with a net drop.
    // volRatio keys off return *variance*, so the spike must be choppy —
    // that is what a real volatility event looks like.
    const calm = Array.from({ length: 21 }, (_, i) => 100 + (i % 2) * 0.01);
    const spike = [101, 97, 103, 96, 91];
    const s = computeSignals("ETH", mkKlines([...calm, ...spike]));
    expect(s.volRatio).toBeGreaterThan(1.3);
    expect(s.priceChange4hPct).toBeLessThan(-5);
    // The pair is what makes the falling-knife call: disorderly AND falling,
    // while we are underweight.
    expect(isMoveInProgress(s, -6)).toBe(true);
  });

  it("does not call a smooth trend a volatility event", () => {
    // A steady ramp moves price a long way with low return variance.
    // volRatio alone must not flag it; priceChange is what carries magnitude.
    const calm = Array.from({ length: 21 }, (_, i) => 100 + (i % 2) * 0.01);
    const ramp = [101, 104, 108, 113, 119];
    const s = computeSignals("ETH", mkKlines([...calm, ...ramp]));
    expect(s.priceChange4hPct).toBeGreaterThan(5);
    expect(s.volRatio).toBeLessThan(1.3);
    expect(isMoveInProgress(s, 6)).toBe(false);
  });

  it("reports a ratio near 1 for a steady series", () => {
    const steady = Array.from({ length: 30 }, (_, i) => 100 * 1.001 ** i);
    const s = computeSignals("BTC", mkKlines(steady));
    expect(s.volRatio).toBeGreaterThan(0.2);
    expect(s.volRatio).toBeLessThan(3);
  });

  it("does not divide by zero on a perfectly flat series", () => {
    const s = computeSignals("BTC", mkKlines(Array(30).fill(100)));
    expect(Number.isFinite(s.volRatio)).toBe(true);
    expect(s.volRatio).toBe(1);
  });

  it("detects a falling knife only when the move matches the drift sign", () => {
    const falling = { symbol: "SOL", realizedVol24h: 1, realizedVol4h: 2, volRatio: 2, priceChange4hPct: -8, priceChange24hPct: -12 };
    // Underweight (negative drift) caused by an ongoing fall -> in progress.
    expect(isMoveInProgress(falling, -6)).toBe(true);
    // Same move but we are overweight -> not the knife case.
    expect(isMoveInProgress(falling, +6)).toBe(false);
    // Calm market -> never.
    expect(isMoveInProgress({ ...falling, volRatio: 1, priceChange4hPct: -0.2 }, -6)).toBe(false);
  });
});

describe("cost/benefit", () => {
  const drifted = computeDrift(
    buildHoldings({ BTC: 0.4, ETH: 5, SOL: 75, AVAX: 375, USDT: 10_000 }, { ...prices, ETH: 8_000 }, "USDT"),
    alloc,
  );
  const { candidates } = generateCandidates({
    state: drifted,
    exchangeInfo,
    books: { ...books(), ETH: syntheticBook("ETHUSDT", 8_000) },
    cashSymbol: "USDT",
  });

  it("reduces drift and prices the reduction", () => {
    const cb = computeCostBenefit(drifted, candidates);
    expect(cb.estimatedCostUsd).toBeGreaterThan(0);
    expect(cb.driftReductionPp).toBeGreaterThan(0);
    expect(cb.totalDriftAfterPp).toBeLessThan(cb.totalDriftBeforePp);
    expect(cb.costPerPpUsd).toBeCloseTo(
      cb.estimatedCostUsd / Math.max(cb.driftReductionPp, 0.01),
      8,
    );
  });

  it("does not divide by zero when nothing would change", () => {
    const cb = computeCostBenefit(drifted, []);
    expect(Number.isFinite(cb.costPerPpUsd)).toBe(true);
    expect(cb.estimatedCostUsd).toBe(0);
  });

  it("nets trade deltas per symbol with the correct sign", () => {
    const d = deltasFromTrades(candidates);
    for (const t of candidates) {
      expect(Math.sign(d[t.symbol])).toBe(t.side === "BUY" ? 1 : -1);
    }
  });
});
