/**
 * A year of decisions, not one screenshot.
 *
 * `docs/hold-example.json` holds a single captured HOLD. One HOLD is an
 * anecdote — it could be luck, or a prompt tuned until it produced the answer
 * the README wanted. A sequence is the actual claim: that the agent declines
 * for *different reasons*, acts when the reasons stop applying, and is not a
 * threshold rule with a paragraph attached.
 *
 * So this walks the captured year, checks the portfolio on a fixed cadence, and
 * runs the full loop at every check. Fills are applied, so a rebalance changes
 * what the next check sees — the sequence is a history, not 26 independent
 * questions about the same portfolio.
 *
 * Writes docs/decision-log.json. Costs real model calls: roughly two per check
 * that finds something outside its band.
 *
 * Usage:
 *   npm run decisions
 *   npm run decisions -- --every 336 --pace 3000
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runReview } from "../src/agent";
import { PaperAccount, ReplayAdapter, type ReplayDataset } from "../src/adapters/replay";
import { flattenTargets } from "../src/core/allocation";
import { bandsFor, volScales } from "../src/core/bands";
import { buildHoldings, computeDrift } from "../src/core/drift";
import { resolveProvider } from "../src/llm/provider";
import type { Allocation, Kline, Preference } from "../src/types";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Built from the window's own symbols rather than hard-coded.
 *
 * A fixed allocation and a captured window are two independent things, and
 * pinning one to the other is exactly the bug P0 fixed in the app: the pair
 * drifted apart and two positions priced at zero. 30% in the largest, the rest
 * split evenly, 10% cash.
 */
function allocationFor(symbols: string[]): Allocation {
  const risk = symbols.filter((s) => s !== "USDT");
  const rest = risk.length > 1 ? 0.6 / (risk.length - 1) : 0;
  return {
    cashSymbol: "USDT",
    targets: [
      ...risk.map((symbol, i) => ({
        kind: "asset" as const,
        symbol,
        weight: i === 0 ? (risk.length > 1 ? 0.3 : 0.9) : rest,
      })),
      { kind: "asset" as const, symbol: "USDT", weight: 0.1 },
    ],
  };
}

type Entry = {
  bar: number;
  date: string;
  verdict: "REBALANCE" | "PARTIAL" | "HOLD";
  primaryFactor: string;
  totalDriftPp: number;
  navUsd: number;
  outsideBand: string[];
  actedOn: string[];
  declined: string[];
  reason: string;
  costUsd: number | null;
  fellBack: boolean;
};

async function main() {
  const dataPath = path.resolve(arg("data", "data/window-365d.json"));
  const preference = arg("tracking", "balanced") as Preference;
  const from = Number(arg("from", "336"));
  const every = Number(arg("every", "336")); // fortnightly on hourly bars
  const pace = Number(arg("pace", "3000"));
  const navUsd = Number(arg("nav", "100000"));
  const out = path.resolve(arg("out", "docs/decision-log.json"));

  const provider = resolveProvider();
  if (provider.kind === "none") {
    console.error("No provider configured. A log of deterministic fallbacks proves nothing.");
    process.exit(1);
  }

  const dataset = JSON.parse(await readFile(dataPath, "utf8")) as ReplayDataset;
  const adapter = new ReplayAdapter(dataset);
  const bands = bandsFor(preference);
  const ALLOCATION = allocationFor(dataset.symbols);

  // Buy the allocation once, then let the market and the agent act on it.
  adapter.seek(from);
  const weights = flattenTargets(ALLOCATION);
  const seedPrices = await adapter.getPrices(Object.keys(weights));
  const seed: Record<string, number> = {};
  for (const [s, w] of Object.entries(weights)) {
    const px = s === "USDT" ? 1 : seedPrices[s];
    if (px > 0) seed[s] = (navUsd * w) / px;
  }
  const account = new PaperAccount(seed, adapter, "USDT");
  const risk = Object.keys(weights).filter((s) => s !== "USDT");

  console.log(`${path.basename(dataPath)} · ${preference} · every ${(every / 24).toFixed(0)} days`);
  console.log(
    `Allocation: ${ALLOCATION.targets.map((t) => `${t.kind === "asset" ? t.symbol : t.label} ${(t.weight * 100).toFixed(0)}%`).join(" / ")}`,
  );
  console.log(`Provider: ${provider.label}\n`);

  const entries: Entry[] = [];
  let lastActionBar = from;

  const maxChecks = Number(arg("checks", "9999"));
  let checks = 0;

  for (let bar = from + every; bar < adapter.length && checks < maxChecks; bar += every) {
    checks += 1;
    adapter.seek(bar);
    const date = new Date(dataset.klines[dataset.symbols[0]][bar].openTime).toISOString().slice(0, 10);

    const history: Record<string, Kline[]> = {};
    for (const sym of risk) history[sym] = await adapter.getKlines(sym, "1h", 336);

    const prices = await adapter.getPrices(Object.keys(account.holdings));
    const state = computeDrift(buildHoldings(account.holdings, prices, "USDT"), ALLOCATION, {
      bands,
      volScale: volScales(history),
    });
    const outside = state.rows
      .filter((r) => r.outsideBand && r.symbol !== "USDT")
      .map((r) => r.symbol);

    // Nothing outside a band is not a decision — the agent was never asked.
    // Logging it as a HOLD would inflate the record with silence.
    if (outside.length === 0) {
      console.log(`${date}  —          inside every band (${state.totalDriftPp.toFixed(1)}pp)`);
      continue;
    }

    const proposal = await runReview({
      market: adapter,
      allocation: ALLOCATION,
      quantities: account.holdings,
      preference,
      daysSinceLastRebalance: Math.round((bar - lastActionBar) / 24),
      askedLast24h: 0,
    });

    const acted = proposal.orderedTrades;
    for (const t of acted) {
      account.applyFill({
        symbol: t.symbol,
        side: t.side,
        qty: t.qty,
        execPrice: t.estExecPrice,
        feeUsd: t.estFeeUsd,
      });
    }
    if (acted.length > 0) lastActionBar = bar;

    const entry: Entry = {
      bar,
      date,
      verdict: proposal.timing.action,
      primaryFactor: proposal.timing.primaryFactor,
      totalDriftPp: Number(state.totalDriftPp.toFixed(2)),
      navUsd: Number(state.navUsd.toFixed(2)),
      outsideBand: outside,
      actedOn: [...new Set(acted.map((t) => t.symbol))],
      declined: [...new Set(proposal.declined.map((c) => c.symbol))],
      reason: proposal.timing.reasoning.split(/(?<=[.!?])\s/)[0]?.trim() ?? "",
      costUsd: acted.length
        ? Number(acted.reduce((s, t) => s + t.estFeeUsd + t.estSlippageUsd, 0).toFixed(2))
        : null,
      fellBack: proposal.timing.fellBack === true,
    };
    entries.push(entry);

    console.log(
      `${date}  ${entry.verdict.padEnd(10)} ${entry.primaryFactor.padEnd(16)} ` +
        `${entry.totalDriftPp.toFixed(1)}pp  ${entry.reason.slice(0, 60)}`,
    );

    await sleep(pace);
  }

  const holds = entries.filter((e) => e.verdict === "HOLD");
  const factors = [...new Set(holds.map((e) => e.primaryFactor))];

  const payload = {
    ranAt: new Date().toISOString(),
    dataset: path.basename(dataPath),
    provider: provider.label,
    tracking: preference,
    bands,
    checkedEveryBars: every,
    startNavUsd: navUsd,
    allocation: ALLOCATION,
    note:
      "Every check where something was outside its band, in order, with fills applied so each " +
      "decision changes what the next one sees. Checks with nothing outside a band are omitted: " +
      "the agent was never asked, and logging them as HOLDs would pad the record with silence.",
    summary: {
      decisionPoints: entries.length,
      holds: holds.length,
      partials: entries.filter((e) => e.verdict === "PARTIAL").length,
      rebalances: entries.filter((e) => e.verdict === "REBALANCE").length,
      usedFallback: entries.filter((e) => e.fellBack).length,
      distinctHoldReasons: factors,
      totalCostUsd: Number(entries.reduce((s, e) => s + (e.costUsd ?? 0), 0).toFixed(2)),
    },
    entries,
  };

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(payload, null, 2), "utf8");

  console.log(`\n${entries.length} decision points · ${holds.length} holds · ${payload.summary.rebalances} rebalances`);
  console.log(`hold reasons: ${factors.join(", ") || "none"}`);
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
