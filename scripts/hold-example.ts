/**
 * Capture a real HOLD decision — the proof the product is not a bot.
 *
 * Scans the replay window for bars where a drifting position is still moving
 * (the falling-knife shape), runs the full agent loop there, and stops at the
 * first genuine HOLD. Writes the complete input and output to
 * docs/hold-example.json so the decision can be inspected and cited without
 * re-running anything.
 *
 * A HOLD that came from the deterministic fallback does not count and is
 * rejected — the point is that the *judgment layer* declined to trade while a
 * threshold rule would have fired.
 *
 * Usage:
 *   npm run hold:example
 *   npm run hold:example -- --max-bars 12 --pace 4500
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runReview } from "../src/agent";
import { ReplayAdapter, type ReplayDataset } from "../src/adapters/replay";
import { flattenTargets } from "../src/core/allocation";
import { buildHoldings, computeDrift } from "../src/core/drift";
import { computeSignals, isMoveInProgress } from "../src/core/signals";
import { resolveProvider } from "../src/llm/provider";
import type { Allocation } from "../src/types";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  const dataPath = path.resolve(arg("data", "data/window-365d.json"));
  const seedBar = Number(arg("seed", "30"));
  const maxBars = Number(arg("max-bars", "12"));
  const pace = Number(arg("pace", "4500"));
  const out = path.resolve(arg("out", "docs/hold-example.json"));

  const provider = resolveProvider();
  console.log(`Provider: ${provider.label}`);
  if (provider.kind === "none") {
    console.error("No LLM provider configured — a fallback HOLD would not prove anything.");
    process.exit(1);
  }

  const dataset = JSON.parse(await readFile(dataPath, "utf8")) as ReplayDataset;
  const adapter = new ReplayAdapter(dataset);

  // Seed on target once; the portfolio is then left alone and the market moves.
  adapter.seek(seedBar);
  const weights = flattenTargets(ALLOCATION);
  const seedPrices = await adapter.getPrices(Object.keys(weights));
  const quantities: Record<string, number> = {};
  for (const [s, w] of Object.entries(weights)) {
    const px = s === "USDT" ? 1 : seedPrices[s];
    if (px > 0) quantities[s] = (100_000 * w) / px;
  }

  // Deterministic pre-scan: which bars have a drifting asset still in motion?
  console.log("Scanning for falling-knife bars (no LLM calls)…");
  const candidates: number[] = [];
  for (let i = seedBar + 30; i < adapter.length; i++) {
    adapter.seek(i);
    const prices = await adapter.getPrices(Object.keys(quantities));
    const state = computeDrift(buildHoldings(quantities, prices, "USDT"), ALLOCATION, {
      asOf: adapter.asOf,
    });
    const drifting = state.rows.filter((r) => r.outsideBand && r.symbol !== "USDT");
    if (drifting.length === 0) continue;

    for (const row of drifting) {
      const sig = computeSignals(row.symbol, await adapter.getKlines(row.symbol, "1h", 30));
      if (isMoveInProgress(sig, row.driftPp)) {
        candidates.push(i);
        break;
      }
    }
  }

  console.log(`  ${candidates.length} candidate bars.`);
  if (candidates.length === 0) {
    console.error("No falling-knife bars in this window. Capture a different one.");
    process.exit(1);
  }

  // Spread the attempts across the window rather than taking a single run of
  // consecutive bars, which would all look the same.
  const step = Math.max(1, Math.floor(candidates.length / maxBars));
  const attempts = candidates.filter((_, i) => i % step === 0).slice(0, maxBars);

  console.log(`Running the full loop on ${attempts.length} of them…\n`);

  for (const bar of attempts) {
    adapter.seek(bar);
    const proposal = await runReview({
      market: adapter,
      allocation: ALLOCATION,
      quantities,
      preference: "balanced",
      daysSinceLastRebalance: Math.round((bar - seedBar) / 24),
      asOf: adapter.asOf,
    });

    const t = proposal.timing;
    const flag = t.fellBack ? " [fallback — does not count]" : "";
    console.log(
      `  bar ${String(bar).padStart(5)}  ${proposal.context.asOf.slice(0, 16)}  ` +
        `drift ${proposal.context.portfolio.totalDriftPp.toFixed(1)}pp  ->  ${t.action} (${t.primaryFactor})${flag}`,
    );

    if (t.action === "HOLD" && !t.fellBack) {
      const record = {
        capturedAt: new Date().toISOString(),
        provider: provider.label,
        note:
          "A real HOLD from the judgment layer. A threshold rule would have traded here: " +
          "the position is outside its band. The agent declined and said why.",
        replay: { dataset: path.basename(dataPath), bar, seedBar, asOf: proposal.context.asOf },
        input: {
          allocation: ALLOCATION,
          quantities,
          portfolio: proposal.context.portfolio,
          signals: proposal.context.signals,
          candidates: proposal.context.candidates,
          costBenefit: proposal.context.costBenefit,
          daysSinceLastRebalance: proposal.context.daysSinceLastRebalance,
          preference: proposal.context.preference,
        },
        output: { timing: proposal.timing, narrative: proposal.narrative },
      };

      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, JSON.stringify(record, null, 2) + "\n", "utf8");

      console.log(`\n${"=".repeat(74)}`);
      console.log("HOLD captured.\n");
      console.log(proposal.narrative);
      console.log(`\nreasoning: ${t.reasoning}`);
      console.log(`factor:    ${t.primaryFactor}`);
      console.log(`\nWrote ${out}`);
      return;
    }

    await sleep(pace);
  }

  console.error(
    "\nNo judgment HOLD in the bars tried. Raise --max-bars, or try a different window.\n" +
      "If every attempt says [fallback], run `npm run llm:check` first — the judgment\n" +
      "layer is not actually answering.",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
