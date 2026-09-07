/**
 * Are the two falling-knife constants worth anything?
 *
 * `isMoveInProgress` gates the only judgment arm this product actually uses to
 * decline a trade. It fires on two thresholds — `volRatio >= 1.3` and
 * `|4h move| >= 3%` — and those two numbers were guessed. Every other threshold
 * here was swept against a year of real closes; these were not, which makes
 * them the least-supported numbers in the codebase and the ones carrying the
 * most weight.
 *
 * What the flag claims, stated so it can be checked: *the move that caused this
 * drift is still running, so acting now is worse than acting later.* The
 * direction condition inside the function (move sign must match drift sign) is
 * not in question — it only says the move is the one that caused the problem.
 * The thresholds are.
 *
 * So the measurement is: when the thresholds fire, does the move continue?
 *
 *   benefit = ((P[t+h] - P[t]) / P[t]) * sign(4h move), in bps
 *
 * Positive means waiting got a better price for the trade the drift implies —
 * an overweight that kept rising sells higher later, an underweight that kept
 * falling buys cheaper later. Both collapse to "the move continued".
 *
 * Compared against the bars that pass the move threshold but *fail* the
 * volRatio one, which isolates what volRatio contributes. If the two columns
 * are the same, volRatio is decoration.
 *
 * Deterministic. No LLM, no network.
 *
 * Usage:
 *   npm run knife
 *   npm run knife -- --data data/window-volatile.json --horizons 4,12,24
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ReplayDataset } from "../src/adapters/replay";
import { computeSignals } from "../src/core/signals";
import type { Kline } from "../src/types";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Enough history for the 24h window computeSignals uses. */
const WARMUP = 25;

type Sample = { volRatio: number; move4h: number; benefitBps: number[] };

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const dataPath = path.resolve(arg("data", "data/window-365d.json"));
  const horizons = arg("horizons", "4,12,24").split(",").map(Number);
  const volThresholds = arg("vol", "1.0,1.15,1.3,1.5,2.0").split(",").map(Number);
  const moveThresholds = arg("move", "1,2,3,5").split(",").map(Number);

  const dataset = JSON.parse(await readFile(dataPath, "utf8")) as ReplayDataset;
  const symbols = dataset.symbols.filter((s) => s !== "USDT");
  const maxH = Math.max(...horizons);

  // One pass over every bar of every asset, recording the signals as the
  // product would have seen them and what the price did next.
  const samples: Sample[] = [];

  for (const symbol of symbols) {
    const series: Kline[] = dataset.klines[symbol] ?? [];
    for (let t = WARMUP; t < series.length - maxH; t++) {
      const s = computeSignals(symbol, series.slice(t - WARMUP, t + 1));
      if (s.priceChange4hPct === 0) continue;

      const p = series[t].close;
      const dir = Math.sign(s.priceChange4hPct);
      samples.push({
        volRatio: s.volRatio,
        move4h: Math.abs(s.priceChange4hPct),
        benefitBps: horizons.map((h) => ((series[t + h].close - p) / p) * dir * 10_000),
      });
    }
  }

  console.log(`${path.basename(dataPath)} — ${symbols.join(", ")}`);
  console.log(`${samples.length.toLocaleString("en-US")} bar-observations\n`);
  console.log(
    "Benefit of waiting, in bps: positive means the move continued, so the trade the\n" +
      "drift implies would have got a better price later. Compared against bars that\n" +
      "clear the move threshold but not the volRatio one.\n",
  );

  for (let hi = 0; hi < horizons.length; hi++) {
    const h = horizons[hi];
    console.log(`── wait ${h}h`);
    console.log(
      `   ${"move".padEnd(6)} ${"volRatio".padEnd(9)} ${"fires".padEnd(8)} ${"% of bars".padEnd(10)} ` +
        `${"mean bps".padEnd(10)} ${"median".padEnd(9)} ${"won".padEnd(6)} ${"baseline mean"}`,
    );

    for (const move of moveThresholds) {
      const passedMove = samples.filter((s) => s.move4h >= move);
      if (passedMove.length === 0) continue;

      for (const vol of volThresholds) {
        const fired = passedMove.filter((s) => s.volRatio >= vol);
        // Same move, calm-by-comparison: what volRatio is meant to exclude.
        const control = passedMove.filter((s) => s.volRatio < vol);
        if (fired.length < 30) continue;

        const b = fired.map((s) => s.benefitBps[hi]);
        const c = control.map((s) => s.benefitBps[hi]);
        const won = (b.filter((x) => x > 0).length / b.length) * 100;

        console.log(
          `   ${`${move}%`.padEnd(6)} ${`>=${vol}`.padEnd(9)} ${String(fired.length).padEnd(8)} ` +
            `${`${((fired.length / samples.length) * 100).toFixed(1)}%`.padEnd(10)} ` +
            `${mean(b).toFixed(1).padStart(8)}  ${median(b).toFixed(1).padStart(7)}  ` +
            `${`${won.toFixed(0)}%`.padEnd(6)} ${c.length ? mean(c).toFixed(1) : "—"}`,
        );
      }
      console.log();
    }
  }

  console.log(
    "A threshold pair earns its place only if its mean beats the baseline column by\n" +
      "more than the spread it costs to wait, and fires often enough to matter. If the\n" +
      "two columns match, volRatio is contributing nothing and should go.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
