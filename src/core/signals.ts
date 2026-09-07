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
 *
 * The two thresholds were guessed, then measured — `npm run knife` — because
 * this flag gates the only judgment arm the product actually uses to decline a
 * trade, and every other threshold here had been swept against real closes
 * while these had not. The measurement asks one question: when the flag fires,
 * does the move continue? Benefit is ((P[t+24h] - P[t]) / P[t]) * sign(4h move)
 * in bps, so positive means waiting got a better price for the trade the drift
 * implies. Two windows, chosen to disagree — majors (BTC/ETH/SOL/AVAX, 34,576
 * hourly bars) and a deliberately jumpier basket (BTC/ETH/SUI/TAO/WLD, 43,294):
 *
 *   move >=3%    majors: mean / median / won      volatile: mean / median / won
 *   volRatio 1.0    +2.5 / +10.8 / 51%              +11.9 / -29.3 / 47%
 *   volRatio 1.3   +19.6 / +29.5 / 53%              +17.2 / -17.7 / 48%
 *   volRatio 1.5   +45.6 / +47.0 / 56%              +22.0 /  -5.8 / 49%
 *   volRatio 2.0   +70.0 / +87.2 / 61%              -23.5 /  +7.1 / 50%
 *
 * Three things to read off it, in order of how much they should be trusted:
 *
 *   1. Moving from 1.3 to 1.5 improves mean, median and win rate in BOTH
 *      windows. That is the only change both datasets agree on, so it is the
 *      only one made. 1.3 was firing on bars where waiting did not pay.
 *   2. 2.0 looks best on majors and turns NEGATIVE on the volatile basket. It
 *      is not adopted. Taking the majors column alone would have been fitting
 *      the constant to one dataset.
 *   3. The baseline — same move, calm by comparison — is heavily negative
 *      everywhere (-55bps majors, -34bps volatile at 3%/1.5). So the flag is
 *      separating something real, but read what it separates honestly: bars it
 *      rejects mean-revert, rather than bars it fires on being reliably good.
 *
 * And the part that does not flatter the flag: on the volatile basket the
 * median is still slightly negative and the win rate is a coin flip. Waiting
 * there is a tail bet — it usually costs a little and occasionally saves a lot.
 * That is a defensible thing for a rebalancer to do, since the drift is not
 * going anywhere, but it is not the same claim as "waiting is usually better",
 * and this comment exists so nobody makes the stronger claim by accident.
 *
 * The 3% move threshold survives unchanged: it beats 2% in both windows, and 5%
 * scores better still but fires on 0.4-0.8% of bars, which is too rare to be
 * worth the extra tail risk of never firing when it matters.
 */
export function isMoveInProgress(
  s: AssetSignals,
  driftPp: number,
  opts: { volRatioThreshold?: number; move4hThreshold?: number } = {},
): boolean {
  const volRatioThreshold = opts.volRatioThreshold ?? 1.5;
  const move4hThreshold = opts.move4hThreshold ?? 3;
  if (s.volRatio < volRatioThreshold) return false;
  if (Math.abs(s.priceChange4hPct) < move4hThreshold) return false;
  // Underweight (driftPp < 0) caused by a fall that is still falling,
  // or overweight (driftPp > 0) caused by a rally that is still rallying.
  return Math.sign(s.priceChange4hPct) === Math.sign(driftPp);
}
