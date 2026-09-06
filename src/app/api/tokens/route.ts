import { NextResponse } from "next/server";

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
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 250);

  try {
    const rows = await publicAdapter().getTickerRows(Math.min(Math.max(limit, 1), 500));
    return NextResponse.json({
      tokens: rows.map((r) => ({ ...r, categories: categoriesFor(r.symbol) })),
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not load tokens." },
      { status: 500 },
    );
  }
}
