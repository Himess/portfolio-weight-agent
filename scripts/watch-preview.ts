/**
 * Print the alert, without sending it.
 *
 * "What does the notification actually say?" is a fair question, and answering
 * it with a mockup would be answering a different one. This runs the real agent
 * loop over the committed replay window and renders the exact message the bot
 * would post — same numbers, same prose, same escaping.
 *
 * It needs no bot token and sends nothing. It does spend one LLM request per
 * decision point.
 *
 * Usage:
 *   npm run watch:preview
 *   npm run watch:preview -- --seed 30 --bar 393
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { runReview } from "../src/agent";
import { ReplayAdapter, type ReplayDataset } from "../src/adapters/replay";
import { flattenTargets } from "../src/core/allocation";
import { volScales } from "../src/core/bands";
import { DEFAULT_PLAN_CONFIG } from "../src/core/candidates";
import { buildHoldings, computeDrift } from "../src/core/drift";
import { breachedSymbols } from "../src/lib/watch";
import { composeMessage, toPlainText } from "../src/lib/watch-message";
import { resolveProvider } from "../src/llm/provider";
import type { Allocation, Kline } from "../src/types";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ALLOCATION: Allocation = {
  cashSymbol: "USDT",
  targets: [
    { kind: "asset", symbol: "BTC", weight: 0.4 },
    { kind: "asset", symbol: "ETH", weight: 0.2 },
    {
      kind: "basket",
      label: "L1s",
      weight: 0.3,
      members: [
        { symbol: "SOL", weight: 0.5 },
        { symbol: "AVAX", weight: 0.5 },
      ],
      resolvedAt: "2026-01-01T00:00:00.000Z",
      rationale: "Large-cap alternative layer-1s, equally weighted.",
    },
    { kind: "asset", symbol: "USDT", weight: 0.1 },
  ],
};

const LABEL = "BTC / ETH / L1s / USDT";

async function main() {
  const dataPath = path.resolve(arg("data", "data/demo-window.json"));
  const seedBar = Number(arg("seed", "30"));
  const bars = arg("bar", "")
    ? [Number(arg("bar", "0"))]
    : // Two real decision points from the committed window. In 1200 bars the
      // allocation leaves its band in four episodes totalling 60 hours; these
      // are the start and the tail of the longest one, so the same breach is
      // seen while the move is still running and again after it settles.
      [393, 430];

  const provider = resolveProvider();
  console.log(`Provider: ${provider.label}\n`);

  const dataset = JSON.parse(await readFile(dataPath, "utf8")) as ReplayDataset;
  const adapter = new ReplayAdapter(dataset);

  // Buy the target allocation once, then leave it alone. Drift is whatever the
  // market did — the same premise the app's replay uses.
  adapter.seek(seedBar);
  const weights = flattenTargets(ALLOCATION);
  const seedPrices = await adapter.getPrices(Object.keys(weights));
  const quantities: Record<string, number> = {};
  for (const [s, w] of Object.entries(weights)) {
    const px = s === "USDT" ? 1 : seedPrices[s];
    if (px > 0) quantities[s] = (100_000 * w) / px;
  }

  for (const bar of bars) {
    if (bar >= adapter.length) {
      console.log(`bar ${bar} is past the end of this window (${adapter.length} bars) — skipped\n`);
      continue;
    }
    adapter.seek(bar);

    const prices = await adapter.getPrices(Object.keys(quantities));

    // Volatility-scaled, exactly as watch-run.ts does it. Without this the
    // preview printed bands the product never actually applies, which is worse
    // than printing nothing: it is a plausible wrong number in the docs.
    const history: Record<string, Kline[]> = {};
    for (const sym of Object.keys(quantities).filter((x) => x !== "USDT")) {
      history[sym] = await adapter.getKlines(sym, "1h", 336);
    }

    const state = computeDrift(buildHoldings(quantities, prices, "USDT"), ALLOCATION, {
      bands: DEFAULT_PLAN_CONFIG.bands,
      volScale: volScales(history),
    });
    const breached = breachedSymbols(state, "USDT");
    const when = new Date(dataset.klines[dataset.symbols[0]][bar].openTime)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");

    console.log("─".repeat(72));
    console.log(`bar ${bar} · ${when}Z · total drift ${state.totalDriftPp.toFixed(1)}pp`);
    console.log("─".repeat(72));

    if (breached.length === 0) {
      console.log("Nothing outside its band. No model call, no message.\n");
      continue;
    }

    const proposal = await runReview({
      market: adapter,
      allocation: ALLOCATION,
      quantities,
      preference: "balanced",
      daysSinceLastRebalance: Math.round((bar - seedBar) / 24),
    });

    const html = composeMessage({
      label: LABEL,
      preference: "balanced",
      state,
      breached,
      verdict: proposal.timing.action,
      narrative: proposal.narrative,
      fellBack: proposal.timing.fellBack === true,
    });

    console.log(toPlainText(html));
    console.log(
      `\n[ ${proposal.timing.action} · ${proposal.timing.primaryFactor}` +
        `${proposal.timing.fellBack ? " · FELL BACK" : ""} ]\n`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
