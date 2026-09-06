import { NextResponse } from "next/server";

import { listDatasets, llmAvailable, loadDataset, publicAdapter } from "@/server/session";

export const runtime = "nodejs";

/**
 * What the client needs to render the first screen: whether the judgment layer
 * is available, which replay datasets exist, and live prices for seeding.
 */
export async function GET() {
  const datasets = await listDatasets();
  const first = await loadDataset();

  let prices: Record<string, number> = {};
  try {
    prices = await publicAdapter().getPrices(["BTC", "ETH", "SOL", "AVAX", "BNB", "USDT"]);
  } catch {
    /* offline is survivable; the UI shows a notice */
  }

  return NextResponse.json({
    llmAvailable: llmAvailable(),
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    datasets,
    replay: first
      ? {
          label: first.label ?? null,
          symbols: first.symbols,
          interval: first.interval,
          bars: Math.min(...first.symbols.map((s) => first.klines[s]?.length ?? 0)),
          capturedAt: first.capturedAt,
        }
      : null,
    prices,
  });
}
