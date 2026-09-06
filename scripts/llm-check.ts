/**
 * Judgment-layer validation harness.
 *
 * Runs N calls per decision type against real replay data and reports the
 * schema-pass rate — i.e. how often the model produced something we accepted
 * versus how often we fell back to the deterministic default.
 *
 * This is the measurement that tells you whether a prompt is good enough, and
 * it is the one thing you cannot know by reading the code. A decision that
 * falls back more than about once in ten needs its prompt fixed before the
 * product can claim to have judgment at all.
 *
 * Usage:
 *   npm run llm:check                       # 5 calls per decision
 *   npm run llm:check -- --n 10             # 10 calls per decision
 *   npm run llm:check -- --n 10 --only timing
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { ReplayAdapter, type ReplayDataset } from "../src/adapters/replay";
import { generateCandidates } from "../src/core/candidates";
import { computeCostBenefit } from "../src/core/costbenefit";
import { buildHoldings, computeDrift } from "../src/core/drift";
import { computeSignals } from "../src/core/signals";
import { flattenTargets } from "../src/core/allocation";
import { resolveBasket } from "../src/llm/basket";
import { decideExecution } from "../src/llm/execution";
import { writeNarrative } from "../src/llm/narrative";
import { resolveProvider } from "../src/llm/provider";
import { decideTiming } from "../src/llm/timing";
import type { Allocation, OrderBook, RebalanceContext } from "../src/types";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Free tiers cap requests per minute (Gemini: ~15). Pace the harness so the
 * measurement reflects prompt quality rather than quota exhaustion.
 */
let PACE_MS = 4500;
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const out = await fn();
  await sleep(PACE_MS);
  return out;
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
      rationale: "seed",
    },
    { kind: "asset", symbol: "USDT", weight: 0.1 },
  ],
};

async function buildContext(adapter: ReplayAdapter, dataset: ReplayDataset, bar: number) {
  adapter.seek(30);
  const weights = flattenTargets(ALLOCATION);
  const seedPrices = await adapter.getPrices(Object.keys(weights));
  const quantities: Record<string, number> = {};
  for (const [s, w] of Object.entries(weights)) {
    const px = s === "USDT" ? 1 : seedPrices[s];
    if (px > 0) quantities[s] = (100_000 * w) / px;
  }

  adapter.seek(bar);
  const prices = await adapter.getPrices(Object.keys(quantities));
  const portfolio = computeDrift(buildHoldings(quantities, prices, "USDT"), ALLOCATION, {
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
  });

  const ctx: RebalanceContext = {
    asOf: portfolio.asOf,
    portfolio,
    candidates,
    costBenefit: computeCostBenefit(portfolio, candidates),
    signals,
    daysSinceLastRebalance: Math.round((bar - 30) / 24),
    preference: "balanced",
    cashSymbol: "USDT",
  };
  return ctx;
}

type Tally = { ok: number; fell: number; reasons: string[]; samples: string[] };

function newTally(): Tally {
  return { ok: 0, fell: 0, reasons: [], samples: [] };
}

function report(name: string, t: Tally, n: number) {
  const rate = ((t.ok / n) * 100).toFixed(0);
  const verdict = t.fell === 0 ? "clean" : t.fell === 1 ? "acceptable" : "NEEDS PROMPT WORK";
  console.log(`\n${name}`);
  console.log(`  schema-pass ${t.ok}/${n}  (${rate}%)   ${verdict}`);
  if (t.reasons.length) {
    const counts = new Map<string, number>();
    for (const r of t.reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
    for (const [r, c] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
      console.log(`    ${c}x ${r.slice(0, 150)}`);
    }
  }
  for (const s of t.samples.slice(0, 2)) console.log(`    e.g. ${s}`);
}

async function main() {
  const n = Number(arg("n", "5"));
  const only = arg("only", "");
  const dataPath = path.resolve(arg("data", "data/window-365d.json"));
  const bar = Number(arg("bar", "8484"));
  PACE_MS = Number(arg("pace", "4500"));

  const provider = resolveProvider();
  console.log(`Provider: ${provider.label}`);
  if (provider.kind === "none") {
    console.error(
      "\nNo LLM provider configured. Set one key in .env — GEMINI_API_KEY (free),\n" +
        "GROQ_API_KEY (free), OPENROUTER_API_KEY, or ANTHROPIC_API_KEY. See README.",
    );
    process.exit(1);
  }

  const dataset = JSON.parse(await readFile(dataPath, "utf8")) as ReplayDataset;
  const adapter = new ReplayAdapter(dataset);
  const ctx = await buildContext(adapter, dataset, bar);

  console.log(
    `Fixture: bar ${bar}, drift ${ctx.portfolio.totalDriftPp.toFixed(1)}pp, ` +
      `${ctx.candidates.length} candidate trades, ${n} calls per decision\n`,
  );

  const want = (k: string) => !only || only === k;

  if (want("timing")) {
    const t = newTally();
    for (let i = 0; i < n; i++) {
      const d = await paced(() => decideTiming(ctx));
      if (d.fellBack) {
        t.fell++;
        t.reasons.push(d.fallbackReason ?? "unknown");
      } else {
        t.ok++;
        t.samples.push(`${d.action} (${d.primaryFactor}) — ${d.reasoning.slice(0, 110)}…`);
      }
    }
    report("§7.1 timing", t, n);
  }

  if (want("execution")) {
    const t = newTally();
    for (let i = 0; i < n; i++) {
      const d = await paced(() => decideExecution(ctx, ctx.candidates));
      if (d.fellBack) {
        t.fell++;
        t.reasons.push(d.fallbackReason ?? "unknown");
      } else {
        t.ok++;
        t.samples.push(
          `${d.orderedTrades.length} kept / ${d.droppedCandidates.length} dropped — ${d.orderedTrades[0]?.why?.slice(0, 90) ?? ""}`,
        );
      }
    }
    report("§7.2 execution", t, n);
  }

  if (want("basket")) {
    const t = newTally();
    const universe = ["BTC", "ETH", "SOL", "AVAX", "BNB", "ADA", "DOT", "NEAR", "APT", "SUI", "TIA", "ATOM", "LINK", "UNI", "AAVE", "RENDER", "FET", "TAO", "INJ", "ARB", "OP", "MATIC", "XRP", "DOGE"];
    const volumes = Object.fromEntries(universe.map((s, i) => [s, 1e9 / (i + 1)]));
    for (let i = 0; i < n; i++) {
      const d = await paced(() => resolveBasket({ phrase: "AI tokens", tradable: universe, volumes }));
      if (d.fellBack) {
        t.fell++;
        t.reasons.push(d.fallbackReason ?? "unknown");
      } else {
        t.ok++;
        t.samples.push(
          `${d.members.map((m) => `${m.symbol} ${(m.weight * 100).toFixed(0)}%`).join(", ")} (${d.confidence})`,
        );
      }
    }
    report("§7.3 basket resolution", t, n);
  }

  if (want("narrative")) {
    const t = newTally();
    const timing = {
      action: "REBALANCE" as const,
      assetsToActOn: ctx.candidates.map((c) => c.symbol),
      reasoning: "Drift is well past the band and the cost is trivial relative to the portfolio.",
      primaryFactor: "drift_magnitude" as const,
    };
    const trades = ctx.candidates.map((c) => ({
      ...c,
      method: "spot_market" as const,
      limitPriceOffsetBps: 0,
      why: "market",
    }));
    for (let i = 0; i < n; i++) {
      const out = await paced(() => writeNarrative(ctx, timing, trades));
      // The deterministic template is recognisable by its exact opening clause.
      const isFallback = out.startsWith("Rebalance — ") || out.startsWith("Partial rebalance — ");
      if (isFallback) {
        t.fell++;
        t.reasons.push("fell back to template (see [llm] warnings above for why)");
      } else {
        t.ok++;
        t.samples.push(out.split("\n")[0]);
      }
    }
    report("§7.4 narrative", t, n);
  }

  console.log(
    "\nA fallback is not a crash — the deterministic default is used and the UI says so.\n" +
      "But a decision that falls back often has no judgment in it, which is the whole product.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
