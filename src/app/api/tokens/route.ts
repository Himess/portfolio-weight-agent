import { NextResponse } from "next/server";

import { TokensQuerySchema } from "@/lib/api-contracts";
import { MARKET_LIMIT, rateLimit } from "@/server/guard";
import { failure } from "@/server/respond";
import { publicAdapter } from "@/server/session";
import { categoriesFor } from "@/lib/categories";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/tokens — the tradable universe for the picker.
 *
 * Price, 24h change and volume are live, from a single upstream call. Nothing
 * is hard-coded: the reference UI shipped a static token table with baked-in
 * prices, which would put stale numbers on screen the moment it was written.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, "tokens", MARKET_LIMIT);
  if (limited) return limited;

  try {
    const { limit } = TokensQuerySchema.parse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    const adapter = publicAdapter();
    // Two different things, and conflating them was a bug: `tokens` is the
    // slice the picker shows, ranked by volume and capped; `universe` is
    // every symbol that actually trades against the cash asset. Anything
    // deciding whether a symbol *exists* has to read the second one.
    const [rows, universe] = await Promise.all([
      adapter.getTickerRows(limit),
      adapter.getTradableSymbols(),
    ]);
    return NextResponse.json({
      tokens: rows.map((r) => ({ ...r, categories: categoriesFor(r.symbol) })),
      universe,
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    return failure(err, "Loading the tradable universe");
  }
}
