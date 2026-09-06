/**
 * Does the judgment actually beat the threshold?
 *
 * The product's central claim is that deciding *when* to rebalance beats
 * rebalancing whenever a band is crossed. Everything else in this repo asserts
 * that. This measures it.
 *
 * Three strategies, identical data, identical check points, identical costs:
 *
 *   hold       never rebalances. The control — it isolates how much of the
 *              outcome is the market rather than the strategy.
 *   threshold  rebalances every position outside its band, every time it looks.
 *              This is the bot the product claims to beat.
 *   agent      the full loop, including the LLM timing and execution decisions.
 *
 * On scoring, honestly: rebalancing is not a return-maximising strategy, so
 * "which made more money" over one window is mostly luck. What rebalancing is
 * *for* is holding a portfolio near its target at an acceptable cost. So the
 * scorecard leads with tracking quality (time-weighted average absolute drift)
 * and what was paid to get it, and reports final NAV alongside rather than as
 * the headline.
 *
 * Usage:
 *   npm run backtest -- --no-llm                  # hold vs threshold, instant
 *   npm run backtest -- --every 336 --pace 2500   # all three, fortnightly
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PaperAccount, ReplayAdapter, type ReplayDataset } from "../src/adapters/replay";
import { flattenTargets } from "../src/core/allocation";
import { DEFAULT_PLAN_CONFIG, generateCandidates } from "../src/core/candidates";
import type { PlanConfig } from "../src/types";
import { computeCostBenefit } from "../src/core/costbenefit";
import { buildHoldings, computeDrift } from "../src/core/drift";
import { computeSignals } from "../src/core/signals";
import { decideExecution, materializeTrades } from "../src/llm/execution";
import { decideTiming, deterministicTiming } from "../src/llm/timing";
import { resolveProvider } from "../src/llm/provider";
import type { Allocation, CandidateTrade, OrderBook, RebalanceContext } from "../src/types";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (n: string) => process.argv.includes(`--${n}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Band width is the mandate, and it decides how often the question even gets
 * asked. Wide bands trigger a handful of times a year, so there is little for
 * judgment to change. Narrow bands ask constantly — which is exactly where
 * deciding *when* to act is worth something, and where a bot churns.
 */
let PLAN: PlanConfig = DEFAULT_PLAN_CONFIG;

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

type Strategy = "hold" | "threshold" | "agent";

type Run = {
  name: Strategy;
  account: PaperAccount;
  trades: number;
  costUsd: number;
  /** |drift| sampled at every check, for a time-weighted average */
  driftSamples: number[];
  holds: number;
  /** Checks where this strategy declined while the band was breached */
  declinedWithBreach: number;
  /** Checks where something was actually outside its band — a real question */
  decisionPoints: number;
  /**
   * Fallbacks that mattered. `decideTiming` short-circuits to the deterministic
   * rule when nothing is outside band, which is correct but is not a judgment
   * failure — counting those made "the agent was really the bot" look far worse
   * than it was. Only fallbacks at a real decision point are counted here.
   */
  fallbacks: number;
};

async function buildContext(
  adapter: ReplayAdapter,
  dataset: ReplayDataset,
  quantities: Record<string, number>,
  daysSince: number | null,
): Promise<{ ctx: RebalanceContext; candidates: CandidateTrade[] }> {
  const symbols = Object.keys(flattenTargets(ALLOCATION));
  const prices = await adapter.getPrices(symbols);
  const portfolio = computeDrift(buildHoldings(quantities, prices, "USDT"), ALLOCATION, {
    bands: PLAN.bands,
    asOf: adapter.asOf,
  });

  const drifting = portfolio.rows
    .filter((r) => r.outsideBand && r.symbol !== "USDT")
    .map((r) => r.symbol);

  const books: Record<string, OrderBook> = {};
  const signals = [];
  for (const s of drifting) {
    books[s] = await adapter.getOrderBook(s, 100);
    signals.push(computeSignals(s, await adapter.getKlines(s, "1h", 30)));
  }

  const { candidates } = generateCandidates({
    state: portfolio,
    exchangeInfo: dataset.exchangeInfo,
    books,
    cashSymbol: "USDT",
    config: PLAN,
  });

  return {
    ctx: {
      asOf: portfolio.asOf,
      portfolio,
      candidates,
      costBenefit: computeCostBenefit(portfolio, candidates),
      signals,
      daysSinceLastRebalance: daysSince,
      preference: "balanced",
      cashSymbol: "USDT",
    },
    candidates,
  };
}

function applyFills(run: Run, trades: { symbol: string; side: "BUY" | "SELL"; qty: number; estExecPrice: number; estFeeUsd: number; estSlippageUsd: number }[]) {
  for (const t of trades) {
    run.account.applyFill({
      symbol: t.symbol,
      side: t.side,
      qty: t.qty,
      execPrice: t.estExecPrice,
      feeUsd: t.estFeeUsd,
    });
    // Slippage is already inside estExecPrice; count it for the cost ledger.
    run.costUsd += t.estFeeUsd + t.estSlippageUsd;
    run.trades++;
  }
}

async function main() {
  const dataPath = path.resolve(arg("data", "data/window-365d.json"));
  const every = Number(arg("every", "336")); // fortnightly on hourly bars
  const from = Number(arg("from", "60"));
  const pace = Number(arg("pace", "2500"));
  const nav0 = Number(arg("nav", "100000"));
  const noLlm = flag("no-llm");

  PLAN = {
    ...DEFAULT_PLAN_CONFIG,
    bands: {
      absoluteFloorPp: Number(arg("band-floor", String(DEFAULT_PLAN_CONFIG.bands.absoluteFloorPp))),
      relativeBandPct: Number(arg("band-rel", String(DEFAULT_PLAN_CONFIG.bands.relativeBandPct))),
    },
  };

  const dataset = JSON.parse(await readFile(dataPath, "utf8")) as ReplayDataset;
  const adapter = new ReplayAdapter(dataset);
  const provider = resolveProvider();

  const strategies: Strategy[] = noLlm ? ["hold", "threshold"] : ["hold", "threshold", "agent"];
  if (!noLlm && provider.kind === "none") {
    console.error("No LLM provider configured — run with --no-llm, or set a key.");
    process.exit(1);
  }

  // Identical starting portfolio, bought exactly on target.
  adapter.seek(from);
  const weights = flattenTargets(ALLOCATION);
  const seedPrices = await adapter.getPrices(Object.keys(weights));
  const seed: Record<string, number> = {};
  for (const [s, w] of Object.entries(weights)) {
    const px = s === "USDT" ? 1 : seedPrices[s];
    if (px > 0) seed[s] = (nav0 * w) / px;
  }

  const runs = new Map<Strategy, Run>(
    strategies.map((name) => [
      name,
      {
        name,
        account: new PaperAccount({ ...seed }, adapter, "USDT"),
        trades: 0,
        costUsd: 0,
        driftSamples: [],
        holds: 0,
        declinedWithBreach: 0,
        decisionPoints: 0,
        fallbacks: 0,
      },
    ]),
  );

  const lastRebalanceBar = new Map<Strategy, number>(strategies.map((s) => [s, from]));
  const checkpoints: number[] = [];
  for (let i = from; i < adapter.length; i += every) checkpoints.push(i);

  console.log(`Backtest — ${dataset.label ?? path.basename(dataPath)}`);
  console.log(`  ${checkpoints.length} checks, every ${every} bars (${(every / 24).toFixed(0)} days), from bar ${from}`);
  console.log(`  strategies: ${strategies.join(", ")}${noLlm ? "" : `  ·  agent on ${provider.label}`}`);
  console.log(`  start NAV $${nav0.toLocaleString("en-US")}\n`);

  for (const bar of checkpoints) {
    adapter.seek(bar);
    const line: string[] = [`bar ${String(bar).padStart(5)}  ${adapter.asOf.slice(0, 10)}`];

    for (const name of strategies) {
      const run = runs.get(name)!;
      const daysSince = Math.round(((bar - lastRebalanceBar.get(name)!) * 1) / 24);
      const { ctx, candidates } = await buildContext(adapter, dataset, run.account.holdings, daysSince);

      run.driftSamples.push(ctx.portfolio.totalDriftPp);
      const breached = candidates.length > 0;

      if (name === "hold") {
        line.push(`hold ${ctx.portfolio.totalDriftPp.toFixed(1)}pp`);
        continue;
      }

      if (name === "threshold") {
        // The bot: if anything is outside its band, trade it. No judgment.
        if (breached) {
          applyFills(run, candidates);
          lastRebalanceBar.set(name, bar);
        }
        line.push(`thr ${ctx.portfolio.totalDriftPp.toFixed(1)}pp/${candidates.length}t`);
        continue;
      }

      // agent
      if (breached) run.decisionPoints++;
      const timing = await decideTiming(ctx);
      // Only a fallback at a real decision point says anything about the model.
      if (timing.fellBack && breached) run.fallbacks++;

      if (timing.action === "HOLD") {
        run.holds++;
        if (breached) run.declinedWithBreach++;
        line.push(`agt HOLD ${ctx.portfolio.totalDriftPp.toFixed(1)}pp`);
      } else {
        const subset =
          timing.action === "PARTIAL"
            ? generateCandidates({
                state: ctx.portfolio,
                exchangeInfo: dataset.exchangeInfo,
                books: Object.fromEntries(
                  await Promise.all(
                    timing.assetsToActOn.map(async (s) => [s, await adapter.getOrderBook(s, 100)] as const),
                  ),
                ),
                cashSymbol: "USDT",
                config: PLAN,
                onlySymbols: timing.assetsToActOn,
              }).candidates
            : candidates;

        const execution = await decideExecution({ ...ctx, candidates: subset }, subset);
        if (execution.fellBack && breached) run.fallbacks++;
        const ordered = materializeTrades(execution, subset);
        applyFills(run, ordered);
        if (ordered.length > 0) lastRebalanceBar.set(name, bar);
        line.push(`agt ${timing.action} ${ctx.portfolio.totalDriftPp.toFixed(1)}pp/${ordered.length}t`);
      }

      await sleep(pace);
    }

    console.log("  " + line.join("   "));
  }

  // ---- final scorecard -----------------------------------------------------
  adapter.seek(adapter.length - 1);
  const finalPrices = await adapter.getPrices(Object.keys(weights));

  console.log(`\n${"=".repeat(78)}`);
  console.log("SCORECARD".padEnd(14), "avg |drift|".padStart(12), "cost paid".padStart(12), "trades".padStart(8), "final NAV".padStart(13));
  console.log("-".repeat(78));

  const rows: Record<string, unknown>[] = [];
  for (const name of strategies) {
    const run = runs.get(name)!;
    const holdings = buildHoldings(run.account.holdings, finalPrices, "USDT");
    const nav = holdings.reduce((a, h) => a + h.valueUsd, 0);
    const avgDrift = run.driftSamples.reduce((a, b) => a + b, 0) / Math.max(run.driftSamples.length, 1);

    console.log(
      name.padEnd(14),
      `${avgDrift.toFixed(2)}pp`.padStart(12),
      `$${run.costUsd.toFixed(2)}`.padStart(12),
      String(run.trades).padStart(8),
      `$${Math.round(nav).toLocaleString("en-US")}`.padStart(13),
    );

    rows.push({
      strategy: name,
      avgAbsDriftPp: Number(avgDrift.toFixed(3)),
      costPaidUsd: Number(run.costUsd.toFixed(2)),
      trades: run.trades,
      finalNavUsd: Math.round(nav),
      holds: run.holds,
      declinedWhileBandBreached: run.declinedWithBreach,
      decisionPoints: run.decisionPoints,
      fallbacksAtDecisionPoints: run.fallbacks,
    });
  }

  const thr = runs.get("threshold");
  const agt = runs.get("agent");
  if (thr && agt) {
    const tNav = buildHoldings(thr.account.holdings, finalPrices, "USDT").reduce((a, h) => a + h.valueUsd, 0);
    const aNav = buildHoldings(agt.account.holdings, finalPrices, "USDT").reduce((a, h) => a + h.valueUsd, 0);
    const tDrift = thr.driftSamples.reduce((a, b) => a + b, 0) / thr.driftSamples.length;
    const aDrift = agt.driftSamples.reduce((a, b) => a + b, 0) / agt.driftSamples.length;

    console.log("\nAgent vs threshold bot");
    console.log(`  tracking   ${aDrift.toFixed(2)}pp vs ${tDrift.toFixed(2)}pp   (${aDrift <= tDrift ? "agent tracks at least as closely" : `agent drifts ${(aDrift - tDrift).toFixed(2)}pp wider`})`);
    console.log(`  cost       $${agt.costUsd.toFixed(2)} vs $${thr.costUsd.toFixed(2)}   (${thr.costUsd > 0 ? `${(((thr.costUsd - agt.costUsd) / thr.costUsd) * 100).toFixed(0)}% saved` : "n/a"})`);
    console.log(`  trades     ${agt.trades} vs ${thr.trades}`);
    console.log(`  final NAV  $${Math.round(aNav).toLocaleString("en-US")} vs $${Math.round(tNav).toLocaleString("en-US")}   (${aNav >= tNav ? "+" : ""}$${Math.round(aNav - tNav).toLocaleString("en-US")})`);
    console.log(
      `  judgment ran at ${agt.decisionPoints} decision point(s) — checks where something was actually outside its band`,
    );
    console.log(`  the agent declined ${agt.declinedWithBreach} time(s) where the bot traded`);
    if (agt.fallbacks > 0) {
      console.log(
        `  note: ${agt.fallbacks} of those ${agt.decisionPoints} fell back to the deterministic rule — that much of "agent" was really the bot`,
      );
    } else if (agt.decisionPoints > 0) {
      console.log(`  every one of them was decided by the model, not the fallback`);
    }
  }

  console.log(
    "\nOne window of one market is evidence, not proof. Rebalancing is not a\n" +
      "return-maximising strategy — read tracking and cost first, NAV second.",
  );

  const out = path.resolve(arg("out", "docs/backtest.json"));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(
    out,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        dataset: path.basename(dataPath),
        bands: PLAN.bands,
        provider: noLlm ? null : provider.label,
        checks: checkpoints.length,
        everyBars: every,
        startNavUsd: nav0,
        allocation: ALLOCATION,
        results: rows,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log(`\nWrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
