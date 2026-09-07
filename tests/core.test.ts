import { describe, expect, it } from "vitest";

import {
  allocationSymbols,
  flattenTargets,
  normalizeMemberWeights,
  validateAllocation,
} from "../src/core/allocation";
import {
  DEFAULT_PLAN_CONFIG,
  LIMIT_WORTH_IT_BPS,
  declinedTrades,
  deltasFromTrades,
  generateCandidates,
  precisionOf,
  roundDownToStep,
  roundToTick,
  suggestMethod,
} from "../src/core/candidates";
import {
  REFERENCE_VOL_PCT,
  bandFor,
  bandPpFor,
  realizedVolPct,
  volScaleFor,
  volScales,
} from "../src/core/bands";
import { computeCostBenefit } from "../src/core/costbenefit";
import { buildHoldings, computeDrift, computeNav, entryShape } from "../src/core/drift";
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
    // The message is for a person: the gap and its direction, not four decimals.
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/20\.0pp still to place/);
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

  it("bands a position by floor, relative share and cap in that order", () => {
    const b = DEFAULT_PLAN_CONFIG.bands; // balanced: 0.7pp floor, 6% relative, 1.5pp cap
    expect(bandFor(0.05, b)).toBeCloseTo(0.7, 10); // 0.06 * 5  = 0.30 -> floor wins
    expect(bandFor(0.2, b)).toBeCloseTo(1.2, 10); //  0.06 * 20 = 1.20 -> relative wins
    expect(bandFor(0.4, b)).toBeCloseTo(1.5, 10); //  0.06 * 40 = 2.40 -> cap wins
    expect(bandFor(0.9, b)).toBeCloseTo(1.5, 10); //  still the cap
  });

  it("leaves a config without a cap behaving exactly as it used to", () => {
    // The cap is optional so an older PlanConfig keeps its meaning.
    const uncapped = { absoluteFloorPp: 2.0, relativeBandPct: 0.25 };
    expect(bandFor(0.4, uncapped)).toBeCloseTo(10, 10);
  });

  it("widens or narrows every band with the tracking preference", () => {
    // The preference used to reach only the timing prompt, so all three
    // produced the identical band and the setting did nothing to what the user
    // was shown.
    const w = 0.4;
    expect(bandPpFor("patient", w)).toBeGreaterThan(bandPpFor("balanced", w));
    expect(bandPpFor("balanced", w)).toBeGreaterThan(bandPpFor("tight", w));
    expect(bandPpFor("tight", w)).toBeGreaterThan(bandPpFor("continuous", w));
    // The rungs are the measured rows of npm run bands:sweep, not interpolations.
    expect(bandPpFor("patient", w)).toBeCloseTo(2.5, 10);
    expect(bandPpFor("balanced", w)).toBeCloseTo(1.5, 10);
    expect(bandPpFor("tight", w)).toBeCloseTo(0.75, 10);
    expect(bandPpFor("continuous", w)).toBeCloseTo(0.4, 10);
  });

  it("orders the ladder consistently at every target weight", () => {
    for (const w of [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8]) {
      expect(bandPpFor("patient", w)).toBeGreaterThanOrEqual(bandPpFor("balanced", w));
      expect(bandPpFor("balanced", w)).toBeGreaterThanOrEqual(bandPpFor("tight", w));
      expect(bandPpFor("tight", w)).toBeGreaterThanOrEqual(bandPpFor("continuous", w));
    }
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

// ---------------------------------------------------------------------------
// Volatility-scaled bands
// ---------------------------------------------------------------------------

describe("bands follow the market, not a constant", () => {
  /** Hourly closes with a chosen per-bar volatility, deterministic. */
  function series(sigma: number, n = 400): number[] {
    let price = 100;
    const out = [price];
    // Alternating +/- gives an exact, seed-free standard deviation.
    for (let i = 1; i < n; i++) {
      price *= Math.exp(i % 2 === 0 ? sigma : -sigma);
      out.push(price);
    }
    return out;
  }

  it("says nothing when there is not enough history to say anything", () => {
    expect(realizedVolPct([100, 101, 102])).toBeNull();
    // ...and a null estimate must leave the band exactly as it was.
    expect(volScaleFor(null)).toBe(1);
  });

  it("annualizes hourly returns", () => {
    // sigma per hour -> sigma * sqrt(8760) annualized, as a percentage. The
    // tolerance is for Bessel's correction in the sample stdev, not for slop:
    // the assertion is about the sqrt(8760) factor.
    const sigma = 0.01;
    const v = realizedVolPct(series(sigma))!;
    const expected = sigma * Math.sqrt(8760) * 100;
    expect(Math.abs(v - expected) / expected).toBeLessThan(0.005);
  });

  it("leaves a reference-volatility asset alone", () => {
    expect(volScaleFor(REFERENCE_VOL_PCT)).toBeCloseTo(1, 10);
  });

  it("widens the band for a volatile asset and narrows it for a calm one", () => {
    // Measured on real 2025-26 data: BTC ~43%, WLD ~121% annualized.
    expect(volScaleFor(43)).toBeLessThan(1);
    expect(volScaleFor(121)).toBeGreaterThan(1);
    // Sub-linear on purpose: 2x the volatility must not mean 2x the band.
    expect(volScaleFor(120) / volScaleFor(60)).toBeLessThan(2);
  });

  it("clamps, so one strange fortnight cannot produce a strange band", () => {
    expect(volScaleFor(1)).toBeGreaterThanOrEqual(0.6);
    expect(volScaleFor(100_000)).toBeLessThanOrEqual(2.5);
  });

  it("scales the floor and the relative term", () => {
    // A weight small enough that the cap is not the binding constraint.
    const w = 0.1;
    const plain = bandPpFor("balanced", w);
    expect(bandPpFor("balanced", w, 2)).toBeCloseTo(plain * 2, 10);
    expect(bandPpFor("balanced", w, 0.6)).toBeCloseTo(plain * 0.6, 10);
  });

  it("does NOT scale the cap — that is the whole reason the cap exists", () => {
    // The cap bounds the band on a large position: 25% of a 50% target is
    // 12.5pp, which is not a tolerance. That is a statement about position
    // size, and volatility is a different axis. Scaling the cap put a volatile
    // large position back near the number the cap was added to prevent.
    const w = 0.4;
    expect(bandPpFor("balanced", w)).toBeCloseTo(1.5, 10); // 0.06*40 = 2.4 -> capped
    // Volatile: still the cap, not 3.75pp.
    expect(bandPpFor("balanced", w, 2.5)).toBeCloseTo(1.5, 10);
    // Calm: the cap is a ceiling, not a fixed value, so the band comes down.
    expect(bandPpFor("balanced", w, 0.6)).toBeCloseTo(1.44, 10);
  });

  it("changes which positions are outside their band", () => {
    // 0.9 BTC at 100k is 47.4% of a 190k portfolio against a 40% target:
    // +7.4pp of drift. Balanced bands a 40% position at 1.5pp, so it breaches
    // either way -- use a small deviation where the scaling actually decides.
    const nav = 100_000;
    const px = { BTC: 100_000, ETH: 4_000, SOL: 200, AVAX: 40 };
    // Put BTC 2pp over its 40% target.
    const q = {
      BTC: (nav * 0.42) / px.BTC,
      ETH: (nav * 0.2) / px.ETH,
      SOL: (nav * 0.15) / px.SOL,
      AVAX: (nav * 0.15) / px.AVAX,
      USDT: nav * 0.08,
    };
    const holdings = buildHoldings(q, px, "USDT");

    const fixed = computeDrift(holdings, alloc, { bands: DEFAULT_PLAN_CONFIG.bands });
    expect(fixed.rows.find((r) => r.symbol === "ETH")!.outsideBand).toBe(false);

    // ETH sits at a 20% target, below the cap, so volatility genuinely moves
    // its band. Push it just outside, then make it volatile: the same
    // deviation stops counting.
    const drifted = buildHoldings(
      { BTC: (nav * 0.4) / px.BTC, ETH: (nav * 0.215) / px.ETH, SOL: (nav * 0.15) / px.SOL, AVAX: (nav * 0.15) / px.AVAX, USDT: nav * 0.085 },
      px,
      "USDT",
    );
    const tight = computeDrift(drifted, alloc, { bands: DEFAULT_PLAN_CONFIG.bands });
    expect(tight.rows.find((r) => r.symbol === "ETH")!.outsideBand).toBe(true);

    const loose = computeDrift(drifted, alloc, {
      bands: DEFAULT_PLAN_CONFIG.bands,
      volScale: { ETH: 2.5 },
    });
    expect(loose.rows.find((r) => r.symbol === "ETH")!.outsideBand).toBe(false);
  });

  it("derives a scale per symbol from its own closes", () => {
    const scales = volScales({ CALM: [], LOUD: [] });
    // Empty history is not an excuse to invent a multiplier.
    expect(scales.CALM).toBe(1);
    expect(scales.LOUD).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// What the agent chose not to do
// ---------------------------------------------------------------------------

describe("declined trades", () => {
  const leg = (side: "BUY" | "SELL", symbol: string, id: string) =>
    ({
      id,
      side,
      symbol,
      pair: `${symbol}USDT`,
      qty: 1,
      estNotionalUsd: 1000,
      estFeeUsd: 1,
      estSlippageUsd: 0.5,
      estExecPrice: 1000,
      midPrice: 1000,
      slippageBps: 5,
      sequenceIndex: 0,
    }) as ReturnType<typeof generateCandidates>["candidates"][number];

  const candidates = [leg("SELL", "AVAX", "t1"), leg("BUY", "BTC", "t2"), leg("BUY", "ETH", "t3")];

  it("reports every candidate when nothing is sent — the HOLD case", () => {
    // This is the product's whole claim: a threshold rule fires these three,
    // and the agent returns them as declined rather than as prose.
    expect(declinedTrades(candidates, []).map((c) => c.symbol)).toEqual(["AVAX", "BTC", "ETH"]);
  });

  it("reports nothing when every candidate is sent", () => {
    expect(declinedTrades(candidates, candidates)).toEqual([]);
  });

  it("reports the legs a PARTIAL left out", () => {
    const sent = [{ side: "BUY" as const, symbol: "BTC" }, { side: "BUY" as const, symbol: "ETH" }];
    expect(declinedTrades(candidates, sent).map((c) => c.symbol)).toEqual(["AVAX"]);
  });

  it("matches on side as well as symbol", () => {
    // A BUY of AVAX going out does not mean the SELL of AVAX was sent.
    const sent = [{ side: "BUY" as const, symbol: "AVAX" }];
    expect(declinedTrades(candidates, sent).map((c) => `${c.side} ${c.symbol}`)).toEqual([
      "SELL AVAX",
      "BUY BTC",
      "BUY ETH",
    ]);
  });

  it("does not depend on candidate ids", () => {
    // A PARTIAL regenerates its candidate set, so the ids of the dropped legs
    // exist nowhere to compare against. Matching by id reported nothing declined.
    const regenerated = [leg("BUY", "BTC", "t1"), leg("BUY", "ETH", "t2")];
    expect(declinedTrades(candidates, regenerated).map((c) => c.symbol)).toEqual(["AVAX"]);
  });
});

// ---------------------------------------------------------------------------
// Entering vs correcting
// ---------------------------------------------------------------------------

describe("first entry", () => {
  const px = { BTC: 100_000, ETH: 4_000, SOL: 200, AVAX: 40 };

  it("recognises someone holding only cash", () => {
    const state = computeDrift(buildHoldings({ USDT: 100_000 }, px, "USDT"), alloc);
    const shape = entryShape(state, "USDT");
    expect(shape.initialEntry).toBe(true);
    // Every risk leg, not just the big ones.
    expect(shape.unfundedSymbols.sort()).toEqual(["AVAX", "BTC", "ETH", "SOL"]);
    expect(shape.cashOverPp).toBeCloseTo(90, 1);
  });

  it("does not call an ordinary cash overweight an entry", () => {
    // Funded legs that have drifted are drift, however much cash there is.
    const state = computeDrift(
      buildHoldings({ BTC: 0.25, ETH: 3, SOL: 50, AVAX: 250, USDT: 45_000 }, px, "USDT"),
      alloc,
    );
    const shape = entryShape(state, "USDT");
    expect(shape.cashOverPp).toBeGreaterThan(25);
    expect(shape.initialEntry).toBe(false);
  });

  it("does not call one newly added position an entry", () => {
    // On target except AVAX, which was just added and holds nothing.
    const state = computeDrift(
      buildHoldings({ BTC: 0.4, ETH: 5, SOL: 75, USDT: 10_000 }, px, "USDT"),
      alloc,
    );
    const shape = entryShape(state, "USDT");
    expect(shape.unfundedSymbols).toEqual(["AVAX"]);
    expect(shape.initialEntry).toBe(false);
  });

  it("is false for a portfolio sitting on its target", () => {
    const state = computeDrift(
      buildHoldings({ BTC: 0.4, ETH: 5, SOL: 75, AVAX: 375, USDT: 10_000 }, px, "USDT"),
      alloc,
    );
    expect(entryShape(state, "USDT").initialEntry).toBe(false);
  });
});

describe("execution method from the measured book", () => {
  it("crosses when crossing is nearly free", () => {
    const s = suggestMethod({ slippageBps: 1.2, bookExhausted: false });
    expect(s.method).toBe("spot_market");
    expect(s.limitPriceOffsetBps).toBe(0);
    expect(s.because).toContain("1.2bps");
  });

  it("rests when the book is thin enough for it to matter", () => {
    const s = suggestMethod({ slippageBps: 13.9, bookExhausted: false });
    expect(s.method).toBe("spot_limit");
    // Inside the touch by about half of what crossing would cost: worth doing,
    // close enough to still fill.
    expect(s.limitPriceOffsetBps).toBe(7);
    expect(s.limitPriceOffsetBps).toBeLessThan(13.9);
  });

  it("switches at the stated threshold, not somewhere near it", () => {
    expect(suggestMethod({ slippageBps: LIMIT_WORTH_IT_BPS - 0.1, bookExhausted: false }).method).toBe(
      "spot_market",
    );
    expect(suggestMethod({ slippageBps: LIMIT_WORTH_IT_BPS, bookExhausted: false }).method).toBe(
      "spot_limit",
    );
  });

  it("never rests further out than the cap", () => {
    const s = suggestMethod({ slippageBps: 500, bookExhausted: false });
    expect(s.limitPriceOffsetBps).toBe(50);
  });

  it("rests when the book ran out, whatever the measured slippage says", () => {
    // Nothing left at this size: the walk price is not a price anyone will fill.
    const s = suggestMethod({ slippageBps: 0.5, bookExhausted: true });
    expect(s.method).toBe("spot_limit");
    expect(s.because).toContain("exhausted");
  });

  it("treats a negative slippage figure by magnitude", () => {
    expect(suggestMethod({ slippageBps: -20, bookExhausted: false }).method).toBe("spot_limit");
  });
});

// ---------------------------------------------------------------------------
// Sizing against a book that cannot fill
// ---------------------------------------------------------------------------

describe("an order is never sized larger than the book can fill", () => {
  /** A book with a hard depth limit, so the walk genuinely runs out. */
  function shallow(pair: string, price: number, totalQty: number): OrderBook {
    return {
      symbol: pair,
      bids: [{ price: price * 0.999, qty: totalQty }],
      asks: [{ price: price * 1.001, qty: totalQty }],
    };
  }

  const alloc2: Allocation = {
    cashSymbol: "USDT",
    targets: [
      { kind: "asset", symbol: "SOL", weight: 0.9 },
      { kind: "asset", symbol: "USDT", weight: 0.1 },
    ],
  };

  const info: ExchangeInfo = { symbols: { SOLUSDT: filters("SOLUSDT", "SOL", { stepSize: 0.001, minQty: 0.001 }) } };

  it("caps the quantity to what actually fills, and prices it there", () => {
    // Wants a large SOL position; the book holds only 10 SOL.
    const holdings = buildHoldings({ USDT: 100_000 }, { SOL: 200, USDT: 1 }, "USDT");
    const state = computeDrift(holdings, alloc2);
    const { candidates } = generateCandidates({
      state,
      exchangeInfo: info,
      books: { SOL: shallow("SOLUSDT", 200, 10) },
      cashSymbol: "USDT",
    });

    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    // 90% of $100k at $200 would be 450 SOL. The book has 10.
    expect(c.qty).toBeLessThanOrEqual(10);
    // And the notional is that quantity at the price it would actually pay —
    // full size at a partial vwap was the bug.
    expect(c.estNotionalUsd).toBeCloseTo(c.qty * c.estExecPrice, 2);
    expect(c.estNotionalUsd).toBeLessThan(3_000);
  });

  it("says why the rest was left behind", () => {
    const holdings = buildHoldings({ USDT: 100_000 }, { SOL: 200, USDT: 1 }, "USDT");
    const state = computeDrift(holdings, alloc2);
    const { skipped } = generateCandidates({
      state,
      exchangeInfo: info,
      books: { SOL: shallow("SOLUSDT", 200, 10) },
      cashSymbol: "USDT",
    });
    expect(skipped.some((s) => /runs out|cannot fill/.test(s.reason))).toBe(true);
  });
});

describe("the sell cap is the balance, not a reconstructed one", () => {
  it("never proposes selling more than is held when the book mid differs", () => {
    // currentValueUsd comes from the ticker; mid comes from the book. Dividing
    // one by the other overstated the balance whenever mid sat below ticker.
    const info: ExchangeInfo = { symbols: { SOLUSDT: filters("SOLUSDT", "SOL", { stepSize: 0.001, minQty: 0.001 }) } };
    const alloc3: Allocation = {
      cashSymbol: "USDT",
      targets: [
        { kind: "asset", symbol: "SOL", weight: 0.1 },
        { kind: "asset", symbol: "USDT", weight: 0.9 },
      ],
    };
    const heldQty = 100;
    // Ticker says $220; the book mid is $200 — a 10% gap.
    const holdings = buildHoldings({ SOL: heldQty, USDT: 1_000 }, { SOL: 220, USDT: 1 }, "USDT");
    const state = computeDrift(holdings, alloc3);
    const { candidates } = generateCandidates({
      state,
      exchangeInfo: info,
      books: { SOL: syntheticBook("SOLUSDT", 200) },
      cashSymbol: "USDT",
    });

    const sell = candidates.find((c) => c.side === "SELL");
    expect(sell).toBeDefined();
    expect(sell!.qty).toBeLessThanOrEqual(heldQty);
  });
});
