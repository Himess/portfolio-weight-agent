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

// Keyed by file: describeDatasets() reads every window, and a single-entry
// cache would evict the default on every call.
const datasetCache = new Map<string, ReplayDataset>();

/** Does this parse as a replay window, rather than merely live in data/? */
function isDataset(value: unknown): value is ReplayDataset {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Partial<ReplayDataset>;
  return Array.isArray(d.symbols) && d.symbols.length > 0 && typeof d.klines === "object";
}

/**
 * Replay windows in data/.
 *
 * Filtered by shape, not by filename. Name-based filtering is how the watch
 * store — data/watches.json, written by the Telegram layer — ended up being
 * offered as a replay dataset and crashing the context route on a field it
 * does not have. Anything in this directory that does not parse as a window is
 * simply not one.
 */
export async function listDatasets(): Promise<string[]> {
  let files: string[];
  try {
    files = (await readdir(DATA_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const file of files) {
    const cached = datasetCache.get(file);
    if (cached) {
      out.push(file);
      continue;
    }
    try {
      const parsed = JSON.parse(await readFile(path.join(DATA_DIR, file), "utf8"));
      if (!isDataset(parsed)) continue;
      datasetCache.set(file, parsed);
      out.push(file);
    } catch {
      // Unreadable or malformed is the same as not a dataset.
    }
  }
  return out.sort();
}

/**
 * The window the demo opens on when nothing is named.
 *
 * Not `files[0]`. That was alphabetical, so committing `demo-volatile.json`
 * silently moved the default off `demo-window.json` and onto a dataset whose
 * symbols the starting allocation does not contain — two positions then priced
 * at zero and half the headline drift figure was an artifact.
 */
const DEFAULT_DATASET = "demo-window.json";

export async function loadDataset(file?: string): Promise<ReplayDataset | null> {
  const files = await listDatasets();
  if (files.length === 0) return null;
  const chosen =
    file && files.includes(file)
      ? file
      : files.includes(DEFAULT_DATASET)
        ? DEFAULT_DATASET
        : files[0];

  const cached = datasetCache.get(chosen);
  if (cached) return cached;

  const raw = await readFile(path.join(DATA_DIR, chosen), "utf8");
  const data = JSON.parse(raw) as ReplayDataset;
  datasetCache.set(chosen, data);
  return data;
}

export type DatasetInfo = {
  file: string;
  label: string | null;
  symbols: string[];
  bars: number;
  /** Open time of the first bar, so the UI can show dates rather than indices. */
  startsAt: number | null;
  barMs: number;
};

/** Milliseconds per bar for the intervals the capture script emits. */
export function barMsFor(interval: string): number {
  if (interval === "4h") return 14_400_000;
  if (interval === "1d") return 86_400_000;
  return 3_600_000;
}

/** Every shipped window with what it covers. Cheap: each is read once and cached. */
export async function describeDatasets(): Promise<DatasetInfo[]> {
  const files = await listDatasets();
  const out: DatasetInfo[] = [];
  for (const file of files) {
    const data = await loadDataset(file);
    if (!data) continue;
    out.push({
      file,
      label: data.label ?? null,
      symbols: data.symbols,
      bars: Math.min(...data.symbols.map((s) => data.klines[s]?.length ?? 0)),
      startsAt: data.klines[data.symbols[0]]?.[0]?.openTime ?? null,
      barMs: barMsFor(data.interval),
    });
  }
  // The default first, so a picker rendering them in order leads with it.
  return out.sort((a, b) => (a.file === "demo-window.json" ? -1 : b.file === "demo-window.json" ? 1 : 0));
}

export async function replayAdapter(file?: string, bar?: number) {
  const data = await loadDataset(file);
  if (!data) return null;
  const adapter = new ReplayAdapter(data);
  adapter.seek(bar ?? adapter.length - 1);
  return adapter;
}

/**
 * One adapter per quote asset, shared across requests.
 *
 * This was constructing a fresh instance per API call, which threw away the
 * caches with it: every request re-downloaded the ~1.9 MB ticker snapshot from
 * Binance. Measured at 356-919ms of pure waste per request, plus the bandwidth
 * and the rate-limit budget.
 */
const adapters = new Map<string, PublicAdapter>();

export function publicAdapter(quote = "USDT"): PublicAdapter {
  let adapter = adapters.get(quote);
  if (!adapter) {
    adapter = new PublicAdapter(quote);
    adapters.set(quote, adapter);
  }
  return adapter;
}

/**
 * Balances from the connected Binance account.
 *
 * Market data still comes from the public API even when MCP is connected — it
 * is the same data, needs no authorization, and keeps the analysis path working
 * if the connection drops mid-session. MCP is used for the two things only it
 * can do: read the real balances, and place an approved order.
 */
export async function mcpBalances(cashSymbol = "USDT") {
  const { discover } = await import("../server/mcp-client");
  const { McpAccountAdapter } = await import("../adapters/mcp");
  const { callTool } = await import("../server/mcp-client");

  const { capabilities } = await discover();
  if (!capabilities.balances) {
    throw new Error(
      "The connected Binance MCP server exposes no balance tool, so holdings cannot be read from it.",
    );
  }

  const adapter = new McpAccountAdapter({ call: callTool }, capabilities, cashSymbol);
  return adapter.getBalances();
}

export function statusFor(kind: "public" | "replay" | "mcp"): AdapterStatus {
  if (kind === "mcp") {
    return {
      kind: "mcp",
      label: "Binance account (MCP)",
      canReadMarket: true,
      canReadAccount: true,
      canTrade: true,
      note: "Balances read from your Agentic sub-account. Every order is confirmed by you in Binance; there is no withdrawal scope.",
    };
  }
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
