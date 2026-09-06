/**
 * Capture a replay dataset — DESIGN.md §8 step 1.
 *
 * Pulls historical klines for a set of symbols plus their exchange filters, and
 * writes a self-contained ReplayDataset. Once captured, the replay runs offline
 * and identically every time — which is the point: the demo must not depend on
 * what the live market happens to be doing during the recording.
 *
 * Usage:
 *   npm run klines -- --symbols BTC,ETH,SOL,AVAX --days 45 --out data/rally.json
 *   npm run klines -- --symbols BTC,ETH --interval 1h --days 30 --label "ETH rally"
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PublicAdapter } from "../src/adapters/public";
import type { ReplayDataset } from "../src/adapters/replay";
import type { Kline } from "../src/types";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required --${name}`);
}

const HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];

async function klinesRange(
  pair: string,
  interval: string,
  startTime: number,
  endTime: number,
): Promise<Kline[]> {
  const out: Kline[] = [];
  let cursor = startTime;

  // Binance caps a single response at 1000 candles, so page forward.
  while (cursor < endTime) {
    const qs = `symbol=${pair}&interval=${interval}&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    let rows: unknown[][] | null = null;
    let lastErr: unknown;

    for (const host of HOSTS) {
      try {
        const res = await fetch(`${host}/api/v3/klines?${qs}`);
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        rows = (await res.json()) as unknown[][];
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!rows) throw lastErr instanceof Error ? lastErr : new Error(`klines failed for ${pair}`);
    if (rows.length === 0) break;

    for (const k of rows) {
      out.push({
        openTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        closeTime: Number(k[6]),
        quoteVolume: Number(k[7]),
      });
    }

    const last = Number(rows[rows.length - 1][6]);
    if (!Number.isFinite(last) || last <= cursor) break;
    cursor = last + 1;
    if (rows.length < 1000) break;
  }

  return out;
}

async function main() {
  const symbols = arg("symbols").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const interval = arg("interval", "1h");
  const days = Number(arg("days", "45"));
  const quote = arg("quote", "USDT");
  const label = arg("label", "");
  const out = path.resolve(arg("out", `data/replay-${Date.now()}.json`));

  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;

  console.log(`Fetching ${interval} klines for ${symbols.join(", ")} over ${days} days…`);

  const klines: Record<string, Kline[]> = {};
  for (const s of symbols) {
    const series = await klinesRange(`${s}${quote}`, interval, startTime, endTime);
    klines[s] = series;
    console.log(`  ${s}: ${series.length} candles`);
  }

  // Align every series to the same length so index N means the same bar
  // for every symbol. Newly-listed assets are the usual cause of a mismatch.
  const minLen = Math.min(...symbols.map((s) => klines[s].length));
  for (const s of symbols) {
    if (klines[s].length !== minLen) {
      console.warn(`  trimming ${s} from ${klines[s].length} to ${minLen} candles to align`);
      klines[s] = klines[s].slice(klines[s].length - minLen);
    }
  }

  const exchangeInfo = await new PublicAdapter(quote).getExchangeInfo(symbols);

  const dataset: ReplayDataset = {
    symbols,
    interval,
    quoteAsset: quote,
    klines,
    exchangeInfo,
    capturedAt: new Date().toISOString(),
    ...(label ? { label } : {}),
  };

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(dataset), "utf8");

  const first = klines[symbols[0]][0];
  const last = klines[symbols[0]][minLen - 1];
  console.log(`\nWrote ${out}`);
  console.log(`  ${minLen} bars, ${new Date(first.openTime).toISOString()} -> ${new Date(last.closeTime).toISOString()}`);
  for (const s of symbols) {
    const series = klines[s];
    const change = ((series[minLen - 1].close - series[0].close) / series[0].close) * 100;
    console.log(`  ${s}: ${series[0].close} -> ${series[minLen - 1].close} (${change >= 0 ? "+" : ""}${change.toFixed(1)}%)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
