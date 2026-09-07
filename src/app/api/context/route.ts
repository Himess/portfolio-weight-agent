import { NextResponse } from "next/server";

import { barMsFor, describeDatasets, llmAvailable, loadDataset, providerLabel, publicAdapter } from "@/server/session";
import { telegramConfigured } from "@/server/telegram";

export const runtime = "nodejs";

/**
 * What the client needs to render the first screen: whether the judgment layer
 * is available, which replay datasets exist, and live prices for seeding.
 */
export async function GET() {
  // Name and coverage for each, so the picker can say what a window contains
  // and the app can refuse an allocation the window cannot price.
  const datasets = await describeDatasets();
  const first = await loadDataset();

  let prices: Record<string, number> = {};
  try {
    prices = await publicAdapter().getPrices(["BTC", "ETH", "SOL", "AVAX", "BNB", "USDT"]);
  } catch {
    /* offline is survivable; the UI shows a notice */
  }

  return NextResponse.json({
    llmAvailable: llmAvailable(),
    model: providerLabel(),
    // Whether standing alerts are possible on this deployment. The card
    // explains its absence rather than failing when someone presses it.
    telegram: telegramConfigured(),
    datasets,
    replay: first
      ? {
          label: first.label ?? null,
          symbols: first.symbols,
          interval: first.interval,
          bars: Math.min(...first.symbols.map((s) => first.klines[s]?.length ?? 0)),
          capturedAt: first.capturedAt,
          // Bar indices are meaningless to anyone who did not write the replay
          // adapter. Send the window's real dates so the UI can say "23 Sep
          // 2025" instead of "bar 393".
          startsAt: first.klines[first.symbols[0]]?.[0]?.openTime ?? null,
          barMs: barMsFor(first.interval),
        }
      : null,
    prices,
  });
}
