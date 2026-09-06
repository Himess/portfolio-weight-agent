/**
 * Server-side helpers shared by the API routes.
 *
 * The LLM calls and any future MCP token live here, never in the browser.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { PublicAdapter } from "../adapters/public";
import { ReplayAdapter, type ReplayDataset } from "../adapters/replay";
import { providerAvailable, resolveProvider } from "../llm/provider";
import type { AdapterStatus } from "../adapters/types";

const DATA_DIR = path.resolve(process.cwd(), "data");

let datasetCache: { file: string; data: ReplayDataset } | null = null;

export async function listDatasets(): Promise<string[]> {
  try {
    const files = await readdir(DATA_DIR);
    return files.filter((f) => f.endsWith(".json") && !f.includes("journal"));
  } catch {
    return [];
  }
}

export async function loadDataset(file?: string): Promise<ReplayDataset | null> {
  const files = await listDatasets();
  if (files.length === 0) return null;
  const chosen = file && files.includes(file) ? file : files[0];

  if (datasetCache?.file === chosen) return datasetCache.data;

  const raw = await readFile(path.join(DATA_DIR, chosen), "utf8");
  const data = JSON.parse(raw) as ReplayDataset;
  datasetCache = { file: chosen, data };
  return data;
}

export async function replayAdapter(file?: string, bar?: number) {
  const data = await loadDataset(file);
  if (!data) return null;
  const adapter = new ReplayAdapter(data);
  adapter.seek(bar ?? adapter.length - 1);
  return adapter;
}

export function publicAdapter(quote = "USDT"): PublicAdapter {
  return new PublicAdapter(quote);
}

export function statusFor(kind: "public" | "replay"): AdapterStatus {
  if (kind === "replay") {
    return {
      kind: "replay",
      label: "Replay (historical)",
      canReadMarket: true,
      canReadAccount: true,
      canTrade: false,
      note: "Historical klines. Order-book depth is modelled, so slippage figures are estimates.",
    };
  }
  return {
    kind: "public",
    label: "Binance public market data",
    canReadMarket: true,
    canReadAccount: false,
    canTrade: false,
    note: "Live prices and real order-book depth. Holdings are entered by you; connect MCP to read them and to place orders.",
  };
}

export function llmAvailable(): boolean {
  return providerAvailable();
}

/** Human-readable description of whichever provider is configured. */
export function providerLabel(): string {
  return resolveProvider().label;
}
