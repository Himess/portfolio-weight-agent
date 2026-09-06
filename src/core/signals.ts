/**
 * Volatility and price-action signals — DESIGN.md §6.
 *
 * Units convention (stated once, applied everywhere): realized vol is the
 * standard deviation of HOURLY log returns, expressed in percent per hour.
 * It is not annualized. The timing decision compares 4h against 24h, so the
 * ratio is what carries meaning and the scaling cancels — but the absolute
 * figure still reaches the user, so it must be labelled consistently.
 *
 * What volRatio actually measures — worth being precise about, because it is
 * the input to the HOLD decision:
 *
 *   It is a ratio of return *variance*, so it detects DISORDER, not trend
 *   magnitude. A smooth, strong ramp has low return variance and will show a
 *   volRatio near or below 1. A choppy, violent move shows a high one. Mixing
 *   a calm stretch with a spike also inflates the 24h denominator, which pushes
 *   the ratio down further for slow trends.
 *
 *   That is why it is never used alone. priceChange4hPct carries direction and
 *   magnitude; volRatio carries "the market is disorderly right now". The
 *   falling-knife shape needs both, which is what isMoveInProgress() checks.
 */

import type { AssetSignals, Kline } from "../types";

/** Sample standard deviation (n-1). Returns 0 for fewer than 2 points. */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Log returns between consecutive closes. */
export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev > 0 && cur > 0) out.push(Math.log(cur / prev));
  }
  return out;
}

/**
 * Build signals from hourly klines, oldest first.
 * Needs 25 candles for a full 24h window; degrades gracefully with fewer.
 */
export function computeSignals(symbol: string, hourly: Kline[]): AssetSignals {
  const closes = hourly.map((k) => k.close).filter((c) => c > 0);

  if (closes.length < 2) {
    return {
      symbol,
      realizedVol24h: 0,
      realizedVol4h: 0,
      volRatio: 1,
      priceChange4hPct: 0,
      priceChange24hPct: 0,
    };
  }

  const window = (n: number) => closes.slice(Math.max(0, closes.length - (n + 1)));

  const vol24 = stdev(logReturns(window(24))) * 100;
  const vol4 = stdev(logReturns(window(4))) * 100;

  const last = closes[closes.length - 1];
  const pctChange = (n: number) => {
    const w = window(n);
    const first = w[0];
    return first > 0 ? ((last - first) / first) * 100 : 0;
  };

  // A flat 24h window would divide by zero; 1.0 reads as "nothing unusual".
  const volRatio = vol24 > 1e-9 ? vol4 / vol24 : 1;

  return {
    symbol,
    realizedVol24h: vol24,
    realizedVol4h: vol4,
    volRatio,
    priceChange4hPct: pctChange(4),
    priceChange24hPct: pctChange(24),
  };
}

/**
 * True when the price move is both large and still accelerating in the
 * direction that created the drift — the "falling knife" shape.
 *
 * This is computed, not judged: it is offered to the LLM as a fact. The LLM
 * decides what to do about it.
 */
export function isMoveInProgress(
  s: AssetSignals,
  driftPp: number,
  opts: { volRatioThreshold?: number; move4hThreshold?: number } = {},
): boolean {
  const volRatioThreshold = opts.volRatioThreshold ?? 1.3;
  const move4hThreshold = opts.move4hThreshold ?? 3;
  if (s.volRatio < volRatioThreshold) return false;
  if (Math.abs(s.priceChange4hPct) < move4hThreshold) return false;
  // Underweight (driftPp < 0) caused by a fall that is still falling,
  // or overweight (driftPp > 0) caused by a rally that is still rallying.
  return Math.sign(s.priceChange4hPct) === Math.sign(driftPp);
}
