import { NextResponse } from "next/server";

import { resolveProvider } from "@/llm/provider";
import { getToken } from "@/server/mcp-session";
import { listDatasets, publicAdapter } from "@/server/session";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/health — what actually works right now.
 *
 * Deliberately more than a 200: each dependency is optional and the app
 * degrades differently without each one, so "is it up" is the wrong question.
 * This answers "what can it do", which is what someone deploying it needs and
 * what makes a failure diagnosable without reading logs.
 *
 * Binance is probed for real rather than assumed reachable — that call is the
 * one thing the app cannot work without.
 */
export async function GET() {
  const started = Date.now();

  const [market, datasets] = await Promise.all([
    probeMarketData(),
    listDatasets().catch(() => [] as string[]),
  ]);

  const provider = resolveProvider();
  const mcp = getToken();

  // Only market data is load-bearing: without it there is nothing to compute.
  // Everything else removes a capability but leaves a working product.
  const status = market.ok ? "ok" : "degraded";

  return NextResponse.json(
    {
      status,
      checkedInMs: Date.now() - started,
      checks: {
        marketData: market,
        judgment: {
          ok: provider.kind !== "none",
          provider: provider.kind === "none" ? null : provider.label,
          detail:
            provider.kind === "none"
              ? "No LLM provider configured — the agent falls back to the deterministic band rule and says so."
              : null,
        },
        replay: {
          ok: datasets.length > 0,
          datasets,
          detail: datasets.length === 0 ? "No captured window. Run `npm run klines`." : null,
        },
        binanceAccount: {
          ok: Boolean(mcp),
          via: mcp?.via ?? null,
          detail: mcp
            ? null
            : "Not connected. Live prices still work; balances and order placement do not.",
        },
      },
    },
    { status: market.ok ? 200 : 503 },
  );
}

async function probeMarketData(): Promise<{ ok: boolean; latencyMs: number | null; detail: string | null }> {
  const t = Date.now();
  try {
    const prices = await publicAdapter().getPrices(["BTC"]);
    const ok = Number.isFinite(prices.BTC) && prices.BTC > 0;
    return {
      ok,
      latencyMs: Date.now() - t,
      detail: ok ? null : "Binance responded without a usable price.",
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
