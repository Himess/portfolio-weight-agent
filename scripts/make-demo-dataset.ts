/**
 * Cut a committable slice out of a captured window.
 *
 * The full year is ~5.5 MB and gitignored, which is right for a working file
 * but means a deployment has no replay source at all — and replay is where the
 * HOLD scene lives, so the deployed app would lose the one thing that proves it
 * is not a threshold bot.
 *
 * This writes a contiguous slice small enough to commit. Contiguous matters:
 * decimating the series would change the volatility figures the timing decision
 * reads, so the demo would be running on different data than the analysis
 * claims. Every bar in the slice is a real bar.
 *
 * Usage:
 *   npm run demo:dataset -- --from data/window-365d.json --bars 1200
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ReplayDataset } from "../src/adapters/replay";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const src = path.resolve(arg("from", "data/window-365d.json"));
  const out = path.resolve(arg("out", "data/demo-window.json"));
  const start = Number(arg("start", "0"));
  const bars = Number(arg("bars", "1200"));

  const data = JSON.parse(await readFile(src, "utf8")) as ReplayDataset;
  const klines: ReplayDataset["klines"] = {};

  for (const symbol of data.symbols) {
    const series = data.klines[symbol] ?? [];
    klines[symbol] = series.slice(start, start + bars);
  }

  const length = Math.min(...data.symbols.map((s) => klines[s].length));
  const sliced: ReplayDataset = {
    ...data,
    klines,
    label: `${data.label ?? "window"} — demo slice`,
  };

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(sliced), "utf8");

  const bytes = JSON.stringify(sliced).length;
  const first = klines[data.symbols[0]][0];
  const last = klines[data.symbols[0]][length - 1];

  console.log(`Wrote ${out}`);
  console.log(`  ${length} bars, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(
    `  ${new Date(first.openTime).toISOString().slice(0, 10)} -> ${new Date(last.closeTime).toISOString().slice(0, 10)}`,
  );
  for (const s of data.symbols) {
    const series = klines[s];
    const change = ((series[length - 1].close - series[0].close) / series[0].close) * 100;
    console.log(`  ${s.padEnd(5)} ${change >= 0 ? "+" : ""}${change.toFixed(1)}%`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
