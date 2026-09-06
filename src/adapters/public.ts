/**
 * PublicAdapter — Binance public market data. No authentication.
 *
 * DESIGN.md §3: "Market data scope is public, needs no auth. The entire
 * read/analysis path can be built and demoed before OAuth works."
 *
 * Falls back to data-api.binance.vision, the public market-data mirror, when
 * api.binance.com is unreachable (it is geo-restricted in some regions and
 * returns 451 there). Only market data is mirrored — that is all we need here.
 */

import type { ExchangeInfo, Kline, OrderBook, SymbolFilters } from "../types";

export type TickerRow = {
  symbol: string;
  pair: string;
  priceUsd: number;
  change24hPct: number;
  quoteVolume24hUsd: number;
};
import type { MarketAdapter } from "./types";

const HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];

type FetchInit = { signal?: AbortSignal };

async function getJson<T>(path: string, init: FetchInit = {}): Promise<T> {
  let lastError: unknown;
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, {
        ...init,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        lastError = new Error(`${host}${path} -> HTTP ${res.status}`);
        // 451/403 means this host is geo-blocked; try the mirror.
        if (res.status === 451 || res.status === 403) continue;
        throw lastError;
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Request failed: ${path}`);
}

type RawFilter = { filterType: string; [k: string]: unknown };
type RawSymbol = {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  filters: RawFilter[];
};

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export class PublicAdapter implements MarketAdapter {
  private exchangeInfoCache = new Map<string, SymbolFilters>();
  private tickerCache: {
    pairs: Set<string>;
    volumes: Record<string, number>;
    rows: TickerRow[];
  } | null = null;

  constructor(private readonly quoteAsset = "USDT") {}

  private pair(symbol: string): string {
    return symbol.endsWith(this.quoteAsset) ? symbol : `${symbol}${this.quoteAsset}`;
  }

  async getPrices(symbols: string[]): Promise<Record<string, number>> {
    const wanted = symbols.filter((s) => s !== this.quoteAsset);
    const out: Record<string, number> = { [this.quoteAsset]: 1 };
    if (wanted.length === 0) return out;

    const pairs = wanted.map((s) => this.pair(s));
    const query = encodeURIComponent(JSON.stringify(pairs));
    const rows = await getJson<{ symbol: string; price: string }[]>(
      `/api/v3/ticker/price?symbols=${query}`,
    );

    const byPair = new Map(rows.map((r) => [r.symbol, num(r.price)]));
    for (const s of wanted) {
      const p = byPair.get(this.pair(s));
      if (p != null) out[s] = p;
    }
    return out;
  }

  async getKlines(symbol: string, interval = "1h", limit = 48): Promise<Kline[]> {
    if (symbol === this.quoteAsset) return [];
    const raw = await getJson<unknown[][]>(
      `/api/v3/klines?symbol=${this.pair(symbol)}&interval=${interval}&limit=${limit}`,
    );
    return raw.map((k) => ({
      openTime: num(k[0]),
      open: num(k[1]),
      high: num(k[2]),
      low: num(k[3]),
      close: num(k[4]),
      volume: num(k[5]),
      closeTime: num(k[6]),
      quoteVolume: num(k[7]),
    }));
  }

  async getOrderBook(symbol: string, depth = 100): Promise<OrderBook> {
    const pair = this.pair(symbol);
    // Binance only accepts specific limit values.
    const allowed = [5, 10, 20, 50, 100, 500, 1000, 5000];
    const limit = allowed.find((a) => a >= depth) ?? 100;
    const raw = await getJson<{ bids: [string, string][]; asks: [string, string][] }>(
      `/api/v3/depth?symbol=${pair}&limit=${limit}`,
    );
    return {
      symbol: pair,
      bids: raw.bids.map(([p, q]) => ({ price: num(p), qty: num(q) })),
      asks: raw.asks.map(([p, q]) => ({ price: num(p), qty: num(q) })),
    };
  }

  /**
   * The tradable universe and 24h volumes, in one call.
   *
   * We deliberately do NOT use the unfiltered /exchangeInfo here: it is ~17 MB
   * and takes seconds to parse. /ticker/24hr is ~1.9 MB and gives us both the
   * symbol universe and the volume ranking that basket resolution needs (§7.3).
   */
  private async getTicker() {
    if (this.tickerCache) return this.tickerCache;
    const raw = await getJson<
      { symbol: string; quoteVolume: string; lastPrice: string; priceChangePercent: string }[]
    >("/api/v3/ticker/24hr");

    const pairs = new Set<string>();
    const volumes: Record<string, number> = {};
    const rows: TickerRow[] = [];

    for (const r of raw) {
      if (!r.symbol.endsWith(this.quoteAsset)) continue;
      const symbol = r.symbol.slice(0, -this.quoteAsset.length);
      pairs.add(r.symbol);
      volumes[symbol] = num(r.quoteVolume);
      rows.push({
        symbol,
        pair: r.symbol,
        priceUsd: num(r.lastPrice),
        change24hPct: num(r.priceChangePercent),
        quoteVolume24hUsd: num(r.quoteVolume),
      });
    }

    rows.sort((a, b) => b.quoteVolume24hUsd - a.quoteVolume24hUsd);
    this.tickerCache = { pairs, volumes, rows };
    return this.tickerCache;
  }

  /**
   * The tradable universe with live price and 24h change, ordered by volume.
   * One upstream call serves the whole token picker — no per-row requests, and
   * nothing here is hard-coded or estimated.
   */
  async getTickerRows(limit = 300): Promise<TickerRow[]> {
    return (await this.getTicker()).rows.slice(0, limit);
  }

  /**
   * Exchange filters for the given base symbols.
   *
   * Always pass the symbols you actually need. Requesting everything pulls a
   * 17 MB document; the filtered form is ~15 KB. Unknown symbols are dropped
   * before the request, because Binance rejects the whole call (-1121) if any
   * one symbol in the list does not exist.
   */
  async getExchangeInfo(symbols?: string[]): Promise<ExchangeInfo> {
    const { pairs } = await this.getTicker();

    const wanted = (symbols ?? [])
      .filter((s) => s !== this.quoteAsset)
      .map((s) => this.pair(s))
      .filter((p) => pairs.has(p));

    const missing = wanted.filter((p) => !this.exchangeInfoCache.has(p));

    if (missing.length > 0) {
      const query = encodeURIComponent(JSON.stringify(missing));
      const raw = await getJson<{ symbols: RawSymbol[] }>(
        `/api/v3/exchangeInfo?symbols=${query}`,
      );
      for (const s of raw.symbols) {
        const byType = new Map(s.filters.map((f) => [f.filterType, f]));
        const lot = byType.get("LOT_SIZE");
        const price = byType.get("PRICE_FILTER");
        // Binance uses NOTIONAL on most pairs, MIN_NOTIONAL on some legacy ones.
        const notional = byType.get("NOTIONAL") ?? byType.get("MIN_NOTIONAL");

        this.exchangeInfoCache.set(s.symbol, {
          pair: s.symbol,
          baseAsset: s.baseAsset,
          quoteAsset: s.quoteAsset,
          stepSize: num(lot?.stepSize, 1e-8),
          minQty: num(lot?.minQty, 0),
          tickSize: num(price?.tickSize, 1e-8),
          minNotional: num(notional?.minNotional, 0),
          status: s.status,
        });
      }
    }

    const out: Record<string, SymbolFilters> = {};
    for (const p of wanted) {
      const f = this.exchangeInfoCache.get(p);
      if (f) out[p] = f;
    }
    return { symbols: out };
  }

  /** 24h quote volume per base symbol — ranks basket candidates (§7.3). */
  async getQuoteVolumes(): Promise<Record<string, number>> {
    return (await this.getTicker()).volumes;
  }

  /** Every base symbol tradable against the cash asset. */
  async getTradableSymbols(): Promise<string[]> {
    const { volumes } = await this.getTicker();
    return Object.keys(volumes);
  }
}
