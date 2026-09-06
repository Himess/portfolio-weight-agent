import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/logo/BTC — official asset logo, proxied.
 *
 * Binance's own static host has the best coverage by far (measured 32/32 across
 * majors and recent listings — TAO, WIF, ENA, EIGEN, BOME, NEIRO, USD1, SOLV,
 * BNSOL — where the `cryptocurrency-icons` package, last published 2022, has
 * none of them). But it refuses hotlinked browser requests: fetching it
 * server-side returns 200, loading the same URL from an <img> fails.
 *
 * So we fetch it here and serve the bytes ourselves. One upstream request per
 * symbol per deploy, then it is cached at the edge and in the browser.
 *
 * A second source is tried when Binance has no logo for a symbol, and a 404 is
 * returned rather than a placeholder — the client already renders a monogram
 * underneath, so a missing logo degrades to a clean initial rather than a
 * broken image.
 */

const SOURCES = [
  (s: string) => `https://bin.bnbstatic.com/static/assets/logos/${s.toUpperCase()}.png`,
  (s: string) => `https://assets.coincap.io/assets/icons/${s.toLowerCase()}@2x.png`,
];

/** Symbols are used to build an upstream URL, so constrain them tightly. */
const SAFE = /^[A-Za-z0-9]{1,15}$/;

export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await ctx.params;

  if (!SAFE.test(symbol)) {
    return new NextResponse("bad symbol", { status: 400 });
  }

  for (const build of SOURCES) {
    try {
      const upstream = await fetch(build(symbol), {
        // Cache upstream for a day; logos effectively never change.
        next: { revalidate: 86_400 },
      });
      if (!upstream.ok) continue;

      const type = upstream.headers.get("content-type") ?? "";
      if (!type.startsWith("image/")) continue;

      return new NextResponse(await upstream.arrayBuffer(), {
        headers: {
          "Content-Type": type,
          // Immutable for a day, then revalidate in the background.
          "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        },
      });
    } catch {
      /* try the next source */
    }
  }

  return new NextResponse(null, { status: 404 });
}
