/**
 * How tight should the band be?
 *
 * "Rebalance more often — maybe daily, maybe several times a day" is a claim
 * about a trade-off, so it is settled by measuring the trade-off rather than by
 * argument. This sweeps band widths from hyperactive to lazy over a year of
 * real hourly closes, checking **every hour** — the highest frequency the data
 * can express — and applies real costs to every fill:
 *
 *   fees       the 10bps taker rate in DEFAULT_PLAN_CONFIG
 *   slippage   walked through the order book to the required depth, not assumed
 *   filters    exchange step/tick/minNotional, so trades too small to place are
 *              not counted as free tracking
 *
 * The costs come from the same `generateCandidates` the product uses, so a
 * result here is a result about this app, not about an idealised model.
 *
 * Two things are reported because they pull in opposite directions:
 *
 *   tracking   time-weighted mean |total drift|. Lower is better and is what
 *              rebalancing is *for*.
 *   NAV        what you ended with after costs. Rebalancing is not a
 *              return-maximising strategy, so this is reported, not headlined.
 *
 * Deterministic. No LLM, no network, no tokens.
 *
 * Usage:
 *   npm run bands
 *   npm run bands -- --every 1 --data data/window-365d.json
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PaperAccount, ReplayAdapter, type ReplayDataset } from "../src/adapters/replay";
import { flattenTargets } from "../src/core/allocation";
import { DEFAULT_PLAN_CONFIG, generateCandidates } from "../src/core/candidates";
import { BANDS, bandFor, realizedVolPct, volScales } from "../src/core/bands";
import { buildHoldings, computeDrift } from "../src/core/drift";
import type { Allocation, BandConfig, Kline, OrderBook } from "../src/types";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * The allocation is taken from the dataset rather than hard-coded, so the same
 * sweep can be pointed at a calm portfolio and a volatile one. Whatever
 * non-cash symbols the window contains are weighted 40/20/15/15... down the
 * list, with a 10% cash leg — concentrated at the top, satellites below, which
 * is the shape this product is for.
 */
function allocationFor(symbols: string[]): Allocation {
  const risk = symbols.filter((s) => s !== "USDT");
  // 30% in the largest, the remaining 60% split evenly, 10% cash. A core with
  // satellites, which is the shape this product is for and the shape people
  // actually describe when asked.
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

let ALLOCATION: Allocation;

/**
 * The four shipped rungs, plus the two looser settings they replaced — so the
 * retune can be read off the same curve that motivated it rather than taken on
 * trust.
 */
const LADDER: { label: string; bands: BandConfig }[] = [
  { label: "continuous", bands: BANDS.continuous },
  { label: "tight", bands: BANDS.tight },
  { label: "balanced", bands: BANDS.balanced },
  { label: "patient", bands: BANDS.patient },
  { label: "(was bal.)", bands: { absoluteFloorPp: 2.0, relativeBandPct: 0.25, absoluteCapPp: 5.0 } },
  { label: "(was pat.)", bands: { absoluteFloorPp: 3.0, relativeBandPct: 0.35, absoluteCapPp: 8.0 } },
];

type Result = {
  label: string;
  bandOn40: number;
  trades: number;
  rebalances: number;
  costUsd: number;
  finalNav: number;
  meanDriftPp: number;
  maxDriftPp: number;
};

async function run(
  dataset: ReplayDataset,
  bands: BandConfig,
  label: string,
  opts: { from: number; every: number; navUsd: number; scaleByVol: boolean; scaleCap: boolean },
): Promise<Result> {
  const adapter = new ReplayAdapter(dataset);
  adapter.seek(opts.from);

  const weights = flattenTargets(ALLOCATION);
  const seedPrices = await adapter.getPrices(Object.keys(weights));
  const seed: Record<string, number> = {};
  for (const [s, w] of Object.entries(weights)) {
    const px = s === ALLOCATION.cashSymbol ? 1 : seedPrices[s];
    if (px > 0) seed[s] = (opts.navUsd * w) / px;
  }

  const account = new PaperAccount(seed, adapter, "USDT");
  const config = { ...DEFAULT_PLAN_CONFIG, bands };
  const exchangeInfo = await adapter.getExchangeInfo();
  const risk = Object.keys(weights).filter((x) => x !== "USDT");

  let trades = 0;
  let rebalances = 0;
  let costUsd = 0;
  let driftSum = 0;
  let driftN = 0;
  let maxDrift = 0;
  let finalNav = opts.navUsd;
  let volScale: Record<string, number> = {};
  const scaleCap = opts.scaleCap;

  for (let bar = opts.from + 1; bar < adapter.length; bar += opts.every) {
    adapter.seek(bar);

    const holdingsMap = account.holdings;
    const symbols = Object.keys(holdingsMap);
    const prices = await adapter.getPrices(symbols);
    const holdings = buildHoldings(holdingsMap, prices, "USDT");

    // Recomputed every bar, exactly as the app does: the band follows the
    // market, so a sweep on fixed bands would not describe the shipped system.
    // Refreshed daily rather than hourly — 24 bars changes a 336-bar estimate
    // by very little, and this loop runs 8,760 times per rung.
    if (opts.scaleByVol && (bar - opts.from) % 24 === 1) {
      const history: Record<string, Kline[]> = {};
      for (const sym of risk) history[sym] = await adapter.getKlines(sym, "1h", 336);
      volScale = volScales(history);
    }

    const state = computeDrift(holdings, ALLOCATION, { bands, volScale, scaleCap });

    finalNav = state.navUsd;
    driftSum += state.totalDriftPp;
    driftN += 1;
    maxDrift = Math.max(maxDrift, state.totalDriftPp);

    const drifting = state.rows.filter((r) => r.outsideBand && r.symbol !== "USDT");
    if (drifting.length === 0) continue;

    const books: Record<string, OrderBook> = {};
    for (const row of drifting) {
      books[row.symbol] = await adapter.getOrderBook(row.symbol, 100);
    }

    const { candidates } = generateCandidates({
      state,
      exchangeInfo,
      books,
      cashSymbol: "USDT",
      config,
    });
    if (candidates.length === 0) continue;

    rebalances += 1;
    for (const t of candidates) {
      account.applyFill({
        symbol: t.symbol,
        side: t.side,
        qty: t.qty,
        execPrice: t.estExecPrice,
        feeUsd: t.estFeeUsd,
      });
      // Slippage is already inside estExecPrice; counted here for the ledger.
      costUsd += t.estFeeUsd + t.estSlippageUsd;
      trades += 1;
    }
  }

  return {
    label,
    bandOn40: bandFor(0.3, bands),
    trades,
    rebalances,
    costUsd,
    finalNav,
    meanDriftPp: driftSum / Math.max(driftN, 1),
    maxDriftPp: maxDrift,
  };
}

async function main() {
  const dataPath = path.resolve(arg("data", "data/window-365d.json"));
  const from = Number(arg("from", "24"));
  const every = Number(arg("every", "1"));
  const navUsd = Number(arg("nav", "100000"));

  const dataset = JSON.parse(await readFile(dataPath, "utf8")) as ReplayDataset;
  ALLOCATION = allocationFor(dataset.symbols);
  const bars = Math.min(...dataset.symbols.map((s) => dataset.klines[s].length));
  const years = (bars - from) / (24 * 365);

  console.log(`${path.basename(dataPath)} — ${bars} bars ≈ ${Math.round((bars - from) / 24)} days`);
  console.log(`checking every ${every} bar${every === 1 ? "" : "s"}, $${navUsd.toLocaleString("en-US")} start\n`);

  // The control: buy once, never touch it. Everything else is measured against
  // this, because "more money" and "less drift" are different questions.
  const scaleByVol = !process.argv.includes("--fixed-bands");
  const scaleCap = process.argv.includes("--scale-cap");
  const control = await run(dataset, { absoluteFloorPp: 1e9, relativeBandPct: 0 }, "never", {
    from,
    every,
    navUsd,
    scaleByVol,
    scaleCap,
  });
  console.log(scaleByVol ? `bands: volatility-scaled${scaleCap ? ", cap scaled too" : ", cap NOT scaled (as shipped)"}` + "\n" : "bands: fixed\n");

  console.log(
    `${"band".padEnd(10)} ${"on 30%".padEnd(8)} ${"rebal/yr".padEnd(10)} ${"trades".padEnd(8)} ` +
      `${"cost".padEnd(11)} ${"cost/yr".padEnd(9)} ${"mean drift".padEnd(11)} ${"final NAV".padEnd(11)} vs never`,
  );

  const line = (r: Result) =>
    `${r.label.padEnd(10)} ` +
    `${(r.bandOn40 > 100 ? "—" : `±${r.bandOn40.toFixed(2)}pp`).padEnd(8)} ` +
    `${(r.rebalances / years).toFixed(0).padEnd(10)} ` +
    `${String(r.trades).padEnd(8)} ` +
    `${`$${Math.round(r.costUsd).toLocaleString("en-US")}`.padEnd(11)} ` +
    `${`${((r.costUsd / navUsd / years) * 100).toFixed(2)}%`.padEnd(9)} ` +
    `${`${r.meanDriftPp.toFixed(2)}pp`.padEnd(11)} ` +
    `${`$${Math.round(r.finalNav).toLocaleString("en-US")}`.padEnd(11)} ` +
    `${r.finalNav >= control.finalNav ? "+" : ""}${(((r.finalNav - control.finalNav) / control.finalNav) * 100).toFixed(2)}%`;

  console.log(line(control));
  const results: Result[] = [];
  for (const rung of LADDER) {
    const r = await run(dataset, rung.bands, rung.label, { from, every, navUsd, scaleByVol, scaleCap });
    results.push(r);
    console.log(line(r));
  }

  console.log(
    `\nmean drift is time-weighted average |total drift| — lower is better tracking, which is\n` +
      `what rebalancing is for. NAV is reported, not headlined: one window is not evidence about\n` +
      `returns. Costs are real fills — 10bps fees plus order-book slippage, exchange filters applied.`,
  );

  // Written so the app can render the measurement rather than a number someone
  // retyped out of a terminal. A figure on screen that no longer matches the
  // code is worse than no figure at all.
  const out = arg("out", "");
  if (!out) return;

  const payload = {
    ranAt: new Date().toISOString(),
    dataset: path.basename(dataPath),
    bars,
    days: Math.round((bars - from) / 24),
    startsAt: new Date(dataset.klines[dataset.symbols[0]][0].openTime).toISOString(),
    checkedEveryBars: every,
    startNavUsd: navUsd,
    volatilityScaled: scaleByVol,
    allocation: ALLOCATION.targets.map((t) => ({
      symbol: t.kind === "asset" ? t.symbol : t.label,
      weight: t.weight,
    })),
    annualizedVolPct: Object.fromEntries(
      dataset.symbols
        .filter((x) => x !== "USDT")
        .map((x) => [x, realizedVolPct(dataset.klines[x].map((k) => k.close))]),
    ),
    rows: [control, ...results].map((r) => ({
      label: r.label,
      baseBandPp: r.bandOn40 > 100 ? null : Number(r.bandOn40.toFixed(3)),
      rebalancesPerYear: Number((r.rebalances / years).toFixed(1)),
      trades: r.trades,
      costUsd: Number(r.costUsd.toFixed(2)),
      costPctPerYear: Number(((r.costUsd / navUsd / years) * 100).toFixed(3)),
      meanDriftPp: Number(r.meanDriftPp.toFixed(3)),
      finalNavUsd: Number(r.finalNav.toFixed(2)),
      navVsNeverPct: Number((((r.finalNav - control.finalNav) / control.finalNav) * 100).toFixed(2)),
    })),
  };
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(path.resolve(out), JSON.stringify(payload, null, 2), "utf8");
  console.log(`
Wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
