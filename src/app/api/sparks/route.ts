import { NextResponse } from "next/server";

import { publicAdapter } from "@/server/session";

export const runtime = "nodejs";
export const maxDuration = 60;

/** In-process cache: a 24h sparkline does not need re-fetching per keystroke. */
const cache = new Map<string, { at: number; closes: number[] }>();
const TTL_MS = 5 * 60_000;
const MAX_SYMBOLS = 14;

/**
 * GET /api/sparks?symbols=BTC,ETH — real hourly closes for sparklines.
 *
 * Binance has no batch-klines endpoint, so this fans out server-side for the
 * handful of rows actually on screen. Capped, cached, and it returns nothing
 * rather than anything invented when a symbol has no series.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("symbols") ?? "";
  const symbols = [...new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(
    0,
    MAX_SYMBOLS,
  );

  if (symbols.length === 0) return NextResponse.json({ series: {} });

  const adapter = publicAdapter();
  const now = Date.now();
  const series: Record<string, number[]> = {};

  await Promise.all(
    symbols.map(async (symbol) => {
      const hit = cache.get(symbol);
      if (hit && now - hit.at < TTL_MS) {
        series[symbol] = hit.closes;
        return;
      }
      try {
        const kl = await adapter.getKlines(symbol, "1h", 24);
        const closes = kl.map((k) => k.close).filter((c) => c > 0);
        if (closes.length >= 3) {
          cache.set(symbol, { at: now, closes });
          series[symbol] = closes;
        }
      } catch {
        /* a missing sparkline is fine; a fabricated one is not */
      }
    }),
  );

  return NextResponse.json({ series });
}
