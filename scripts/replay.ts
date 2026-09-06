/**
 * Replay harness — DESIGN.md §8 steps 2-4.
 *
 * Two modes:
 *
 *   --scan   Deterministic only, no LLM calls. Walks every bar, reconstructs
 *            NAV and weights, and reports the moments worth demoing: where
 *            drift crosses a band, and where a move is still in progress (the
 *            conditions under which HOLD is the right call). Use this to FIND
 *            the demo window before spending a single token.
 *
 *   default  Runs the full agent loop — including the LLM decisions — at
 *            intervals, applying fills to a paper account so each step sees the
 *            consequences of the last. Logs every decision with its inputs.
 *
 * Usage:
 *   npm run replay -- --data data/window-60d.json --scan
 *   npm run replay -- --data data/window-60d.json --from 900 --to 1000 --every 24
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runReview } from "../src/agent";
import { PaperAccount, ReplayAdapter, type ReplayDataset } from "../src/adapters/replay";
import { DEFAULT_PLAN_CONFIG, generateCandidates } from "../src/core/candidates";
import { computeCostBenefit } from "../src/core/costbenefit";
import { buildHoldings, computeDrift } from "../src/core/drift";
import { computeSignals, isMoveInProgress } from "../src/core/signals";
import type { Allocation, Preference } from "../src/types";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required --${name}`);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

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
      resolvedAt: new Date().toISOString(),
      rationale: "Large-cap alternative layer-1s, equally weighted.",
    },
    { kind: "asset", symbol: "USDT", weight: 0.1 },
  ],
};

/** Buy the target allocation exactly, at bar `index`. */
async function seedHoldings(
  adapter: ReplayAdapter,
  navUsd: number,
  index: number,
): Promise<Record<string, number>> {
  adapter.seek(index);
  const prices = await adapter.getPrices(["BTC", "ETH", "SOL", "AVAX", "USDT"]);
  return {
    BTC: (navUsd * 0.4) / prices.BTC,
    ETH: (navUsd * 0.2) / prices.ETH,
    SOL: (navUsd * 0.15) / prices.SOL,
    AVAX: (navUsd * 0.15) / prices.AVAX,
    USDT: navUsd * 0.1,
  };
}

// ---------------------------------------------------------------------------
// Scan — deterministic, no LLM
// ---------------------------------------------------------------------------

async function scan(adapter: ReplayAdapter, dataset: ReplayDataset, startIndex: number) {
  const nav0 = 100_000;
  const quantities = await seedHoldings(adapter, nav0, startIndex);
  const symbols = ["BTC", "ETH", "SOL", "AVAX", "USDT"];

  console.log(`\nScanning ${dataset.label ?? "dataset"} from bar ${startIndex} to ${adapter.length - 1}`);
  console.log("Holdings are seeded on target at the start bar and then left alone.\n");
  console.log(
    ["bar", "date", "NAV", "drift", "outside", "moveInProg", "cost/pp"].join("\t"),
  );

  const interesting: { index: number; why: string; detail: string }[] = [];

  for (let i = startIndex; i < adapter.length; i++) {
    adapter.seek(i);
    const prices = await adapter.getPrices(symbols);
    const holdings = buildHoldings(quantities, prices, "USDT");
    const state = computeDrift(holdings, ALLOCATION, { asOf: adapter.asOf });

    const drifting = state.rows
      .filter((r) => r.outsideBand && r.symbol !== "USDT")
      .map((r) => r.symbol);

    if (drifting.length === 0) {
      if (i % 48 === 0) log(i, adapter.asOf, state.navUsd, state.totalDriftPp, [], [], null);
      continue;
    }

    const books: Record<string, ReturnType<ReplayAdapter["getOrderBook"]> extends Promise<infer T> ? T : never> = {};
    const inProgress: string[] = [];

    for (const s of drifting) {
      books[s] = await adapter.getOrderBook(s, 100);
      const kl = await adapter.getKlines(s, "1h", 30);
      const sig = computeSignals(s, kl);
      const row = state.rows.find((r) => r.symbol === s)!;
      if (isMoveInProgress(sig, row.driftPp)) inProgress.push(s);
    }

    const { candidates } = generateCandidates({
      state,
      exchangeInfo: dataset.exchangeInfo,
      books,
      cashSymbol: "USDT",
      config: DEFAULT_PLAN_CONFIG,
    });
    const cb = computeCostBenefit(state, candidates);

    if (i % 12 === 0 || inProgress.length > 0) {
      log(i, adapter.asOf, state.navUsd, state.totalDriftPp, drifting, inProgress, cb.costPerPpUsd);
    }

    if (inProgress.length > 0) {
      interesting.push({
        index: i,
        why: "HOLD candidate — move still in progress",
        detail: `${inProgress.join(",")} moving; drift ${state.totalDriftPp.toFixed(1)}pp; cost/pp $${cb.costPerPpUsd.toFixed(0)}`,
      });
    } else if (cb.costPerPpUsd > 60 && state.totalDriftPp > 2) {
      interesting.push({
        index: i,
        why: "HOLD candidate — expensive correction",
        detail: `cost/pp $${cb.costPerPpUsd.toFixed(0)} for ${cb.driftReductionPp.toFixed(1)}pp`,
      });
    }
  }

  console.log(`\n${interesting.length} candidate moments found.`);
  const byReason = new Map<string, typeof interesting>();
  for (const x of interesting) {
    if (!byReason.has(x.why)) byReason.set(x.why, []);
    byReason.get(x.why)!.push(x);
  }
  for (const [why, xs] of byReason) {
    console.log(`\n${why} — ${xs.length} bars`);
    // Collapse runs of consecutive bars into ranges; report the first of each.
    let runStart = xs[0];
    let prev = xs[0];
    const runs: { from: number; to: number; detail: string }[] = [];
    for (const x of xs.slice(1)) {
      if (x.index === prev.index + 1) { prev = x; continue; }
      runs.push({ from: runStart.index, to: prev.index, detail: runStart.detail });
      runStart = x;
      prev = x;
    }
    runs.push({ from: runStart.index, to: prev.index, detail: runStart.detail });
    for (const r of runs.slice(0, 12)) {
      console.log(`  bars ${r.from}-${r.to}  ${r.detail}`);
    }
    if (runs.length > 12) console.log(`  … and ${runs.length - 12} more runs`);
  }

  console.log(
    "\nPick a bar from a HOLD-candidate run and pass it to the full loop, e.g.\n" +
      `  npm run replay -- --data ${arg("data")} --from <bar> --to <bar+1>`,
  );
}

function log(
  i: number,
  asOf: string,
  nav: number,
  drift: number,
  outside: string[],
  inProgress: string[],
  costPerPp: number | null,
) {
  console.log(
    [
      i,
      asOf.slice(0, 13),
      `$${Math.round(nav).toLocaleString("en-US")}`,
      `${drift.toFixed(1)}pp`,
      outside.join(",") || "-",
      inProgress.join(",") || "-",
      costPerPp == null ? "-" : `$${costPerPp.toFixed(0)}`,
    ].join("\t"),
  );
}

// ---------------------------------------------------------------------------
// Full loop — with LLM
// ---------------------------------------------------------------------------

async function runLoop(adapter: ReplayAdapter, dataset: ReplayDataset) {
  const from = Number(arg("from", "0"));
  const to = Number(arg("to", String(adapter.length - 1)));
  const every = Number(arg("every", "24"));
  const preference = arg("preference", "balanced") as Preference;
  const nav0 = Number(arg("nav", "100000"));

  const quantities = await seedHoldings(adapter, nav0, from);
  const account = new PaperAccount(quantities, adapter, "USDT");

  let lastRebalanceBar: number | null = null;
  const journal: unknown[] = [];

  for (let i = from; i <= Math.min(to, adapter.length - 1); i += every) {
    adapter.seek(i);

    const daysSince =
      lastRebalanceBar == null ? null : Math.round(((i - lastRebalanceBar) * 60) / (60 * 24));

    const proposal = await runReview({
      market: adapter,
      allocation: ALLOCATION,
      quantities: account.holdings,
      preference,
      daysSinceLastRebalance: daysSince,
      asOf: adapter.asOf,
    });

    const p = proposal;
    console.log(`\n${"=".repeat(78)}`);
    console.log(`bar ${i}  ${p.context.asOf.slice(0, 16)}  NAV $${Math.round(p.context.portfolio.navUsd).toLocaleString("en-US")}`);
    console.log(`drift ${p.context.portfolio.totalDriftPp.toFixed(1)}pp   ->   ${p.timing.action}  (${p.timing.primaryFactor})${p.timing.fellBack ? "  [FALLBACK]" : ""}`);
    if (p.timing.fellBack) console.log(`  fallback reason: ${p.timing.fallbackReason}`);
    console.log(`\n${p.narrative}\n`);

    for (const t of p.orderedTrades) {
      console.log(
        `  ${t.side.padEnd(4)} ${t.qty} ${t.symbol.padEnd(5)} ~$${t.estNotionalUsd.toFixed(0)}  ${t.method}  (${t.why})`,
      );
    }
    if (p.execution?.droppedCandidates.length) {
      for (const d of p.execution.droppedCandidates) {
        console.log(`  DROPPED ${d.candidateId}: ${d.why}`);
      }
    }

    // Apply fills so the next step sees the consequences.
    if (p.orderedTrades.length > 0) {
      for (const t of p.orderedTrades) {
        account.applyFill({
          symbol: t.symbol,
          side: t.side,
          qty: t.qty,
          execPrice: t.estExecPrice,
          feeUsd: t.estFeeUsd,
        });
      }
      lastRebalanceBar = i;
    }

    journal.push({
      bar: i,
      asOf: p.context.asOf,
      navUsd: p.context.portfolio.navUsd,
      totalDriftPp: p.context.portfolio.totalDriftPp,
      action: p.timing.action,
      primaryFactor: p.timing.primaryFactor,
      fellBack: p.timing.fellBack ?? false,
      reasoning: p.timing.reasoning,
      narrative: p.narrative,
      trades: p.orderedTrades.map((t) => ({
        side: t.side, symbol: t.symbol, qty: t.qty,
        notionalUsd: t.estNotionalUsd, method: t.method, why: t.why,
      })),
      costBenefit: p.context.costBenefit,
    });
  }

  const out = path.resolve(arg("journal", "data/replay-journal.json"));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(journal, null, 2), "utf8");
  console.log(`\nJournal written to ${out}`);
}

async function main() {
  const dataPath = path.resolve(arg("data"));
  const dataset = JSON.parse(await readFile(dataPath, "utf8")) as ReplayDataset;
  const adapter = new ReplayAdapter(dataset);

  console.log(`Loaded ${dataset.symbols.join(", ")} — ${adapter.length} bars (${dataset.interval})`);

  if (flag("scan")) {
    // Start after enough history exists for a 24h volatility window.
    await scan(adapter, dataset, Number(arg("from", "30")));
  } else {
    await runLoop(adapter, dataset);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
