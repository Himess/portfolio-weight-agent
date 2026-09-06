import { NextResponse } from "next/server";

import { SparksQuerySchema } from "@/lib/api-contracts";
import { MARKET_LIMIT, rateLimit } from "@/server/guard";
import { TtlCache } from "@/lib/cache";
import { publicAdapter } from "@/server/session";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Bounded so the cache cannot grow one entry per symbol anyone ever searched.
 * `wrap` also collapses concurrent requests for the same symbol into one
 * upstream call, which matters here because the picker asks for a batch on
 * every filter change.
 */
const cache = new TtlCache<number[]>({ ttlMs: 5 * 60_000, max: 400 });

/**
 * GET /api/sparks?symbols=BTC,ETH — real hourly closes for sparklines.
 *
 * Binance has no batch-klines endpoint, so this fans out server-side for the
 * handful of rows actually on screen. Capped, cached, and it returns nothing
 * rather than anything invented when a symbol has no series.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, "sparks", MARKET_LIMIT);
  if (limited) return limited;

  const { symbols } = SparksQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  if (symbols.length === 0) return NextResponse.json({ series: {} });

  const adapter = publicAdapter();
  const series: Record<string, number[]> = {};

  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const closes = await cache.wrap(symbol, async () => {
          const kl = await adapter.getKlines(symbol, "1h", 24);
          const values = kl.map((k) => k.close).filter((c) => c > 0);
          if (values.length < 3) throw new Error("no usable series");
          return values;
        });
        series[symbol] = closes;
      } catch {
        /* a missing sparkline is fine; a fabricated one is not */
      }
    }),
  );

  return NextResponse.json({ series });
}
