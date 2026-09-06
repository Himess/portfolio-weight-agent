import { NextResponse } from "next/server";

import { TokensQuerySchema } from "@/lib/api-contracts";
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
  try {
    const { limit } = TokensQuerySchema.parse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    const rows = await publicAdapter().getTickerRows(limit);
    return NextResponse.json({
      tokens: rows.map((r) => ({ ...r, categories: categoriesFor(r.symbol) })),
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    return failure(err, "Loading the tradable universe");
  }
}
