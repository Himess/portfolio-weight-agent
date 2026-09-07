/**
 * The agent loop — one portfolio review.
 *
 * Deterministic code computes everything; the LLM chooses among precomputed
 * options and explains. This function is the only place the two meet, and the
 * ordering is deliberate:
 *
 *   drift -> candidates -> cost/benefit -> [TIMING] -> candidates again if
 *   PARTIAL -> [EXECUTION] -> materialize from deterministic qty -> [NARRATIVE]
 *
 * Both the UI and the replay harness call this, so a demo and a live run
 * exercise identical logic.
 */

import type { MarketAdapter } from "./adapters/types";
import { allocationSymbols } from "./core/allocation";
import { bandsFor, volScales } from "./core/bands";
import { DEFAULT_PLAN_CONFIG, generateCandidates } from "./core/candidates";
import { computeCostBenefit } from "./core/costbenefit";
import { buildHoldings, computeDrift } from "./core/drift";
import { computeSignals } from "./core/signals";
import { decideExecution, materializeTrades } from "./llm/execution";
import { buildProposal, writeNarrative } from "./llm/narrative";
import { decideTiming } from "./llm/timing";
import type {
  Allocation,
  AssetSignals,
  CandidateTrade,
  Kline,
  OrderBook,
  PlanConfig,
  Preference,
  Proposal,
} from "./types";

export type ReviewInput = {
  market: MarketAdapter;
  allocation: Allocation;
  /** Raw balances, keyed by symbol */
  quantities: Record<string, number>;
  preference: Preference;
  daysSinceLastRebalance: number | null;
  config?: PlanConfig;
  asOf?: string;
  /** Proposals already shown to this owner in the last 24h — the attention budget */
  askedLast24h?: number;
  /** Skip the LLM entirely — used by tests and the deterministic-only mode */
  deterministicOnly?: boolean;
};

/** Two weeks of hourly closes — a stable volatility read without a large fetch. */
const VOL_LOOKBACK_BARS = 336;

export async function runReview(input: ReviewInput): Promise<Proposal> {
  // The tracking preference sets the band. It used to reach only the timing
  // prompt, which meant a tight tracker and a patient one were shown a
  // portfolio at the identical moment — the preference could decline what it
  // was shown but never ask to be shown more.
  const config = input.config ?? { ...DEFAULT_PLAN_CONFIG, bands: bandsFor(input.preference) };
  const cashSymbol = input.allocation.cashSymbol;

  // Every symbol we care about: targets plus anything actually held (an
  // unallocated holding is drift against a zero target, so it must be priced).
  const symbols = [
    ...new Set([...allocationSymbols(input.allocation), ...Object.keys(input.quantities)]),
  ];

  const prices = await input.market.getPrices(symbols);
  const holdings = buildHoldings(input.quantities, prices, cashSymbol);

  // Recent history for every symbol, not just the drifting ones — the band has
  // to be known before we can say which of them are drifting. Two weeks of
  // hourly closes is enough for a stable volatility estimate and is cached.
  const history: Record<string, Kline[]> = {};
  await Promise.all(
    symbols
      .filter((s) => s !== cashSymbol)
      .map(async (symbol) => {
        try {
          history[symbol] = await input.market.getKlines(symbol, "1h", VOL_LOOKBACK_BARS);
        } catch {
          // No history means no scaling for that symbol, which is the same as
          // the fixed band. Never a reason to fail the whole review.
        }
      }),
  );
  const volScale = volScales(history);

  const portfolio = computeDrift(holdings, input.allocation, {
    bands: config.bands,
    asOf: input.asOf,
    volScale,
  });

  // Only fetch depth and history for what is actually drifting — the rest
  // cannot produce a trade, so the calls would be wasted.
  const drifting = portfolio.rows
    .filter((r) => r.outsideBand && r.symbol !== cashSymbol)
    .map((r) => r.symbol);

  const exchangeInfo = await input.market.getExchangeInfo(drifting);

  const books: Record<string, OrderBook> = {};
  const signals: AssetSignals[] = [];

  await Promise.all(
    drifting.map(async (symbol) => {
      const [book, klines] = await Promise.all([
        input.market.getOrderBook(symbol, 100).catch(() => null),
        input.market.getKlines(symbol, "1h", 30).catch(() => []),
      ]);
      if (book) books[symbol] = book;
      signals.push(computeSignals(symbol, klines));
    }),
  );

  const { candidates } = generateCandidates({
    state: portfolio,
    exchangeInfo,
    books,
    cashSymbol,
    config,
  });

  const costBenefit = computeCostBenefit(portfolio, candidates);

  const ctx = {
    asOf: portfolio.asOf,
    portfolio,
    candidates,
    costBenefit,
    signals,
    daysSinceLastRebalance: input.daysSinceLastRebalance,
    preference: input.preference,
    cashSymbol,
    askedLast24h: input.askedLast24h,
  };

  // ---- Decision 1: timing -------------------------------------------------
  const timing = input.deterministicOnly
    ? {
        action: (drifting.length > 0 ? "REBALANCE" : "HOLD") as "REBALANCE" | "HOLD",
        assetsToActOn: drifting,
        reasoning: "Deterministic mode — acting on every position outside its band.",
        primaryFactor: "drift_magnitude" as const,
        fellBack: true,
        fallbackReason: "deterministicOnly",
      }
    : await decideTiming(ctx);

  if (timing.action === "HOLD") {
    const narrative = input.deterministicOnly
      ? `Holding — nothing outside its band.\n\n${timing.reasoning}`
      : await writeNarrative(ctx, timing, []);
    return buildProposal(ctx, timing, null, [], narrative);
  }

  // ---- PARTIAL: re-derive candidates for the chosen subset only -----------
  // Regenerating (rather than filtering) keeps ids and sequencing dense, and
  // recomputes cost/benefit against what will actually be executed.
  let workingCandidates: CandidateTrade[] = candidates;
  let workingCtx = ctx;

  if (timing.action === "PARTIAL") {
    const subset = generateCandidates({
      state: portfolio,
      exchangeInfo,
      books,
      cashSymbol,
      config,
      onlySymbols: timing.assetsToActOn,
    });
    workingCandidates = subset.candidates;
    workingCtx = {
      ...ctx,
      candidates: workingCandidates,
      costBenefit: computeCostBenefit(portfolio, workingCandidates),
    };
  }

  // ---- Decision 2: execution path -----------------------------------------
  const execution = input.deterministicOnly
    ? {
        orderedTrades: workingCandidates.map((c) => ({
          candidateId: c.id,
          method: "spot_market" as const,
          limitPriceOffsetBps: 0,
          why: "Deterministic mode.",
        })),
        droppedCandidates: [],
      }
    : await decideExecution(workingCtx, workingCandidates);

  // Quantities come from the deterministic candidates, never from the model.
  const orderedTrades = materializeTrades(execution, workingCandidates);

  // Dropping legs changes the cost/benefit the user is shown, so recompute.
  const finalCtx = {
    ...workingCtx,
    costBenefit: computeCostBenefit(portfolio, orderedTrades),
  };

  // ---- Decision 3: narrative ----------------------------------------------
  const narrative = input.deterministicOnly
    ? `${timing.action} — ${orderedTrades.length} trades.\n\n${timing.reasoning}`
    : await writeNarrative(finalCtx, timing, orderedTrades);

  return buildProposal(finalCtx, timing, execution, orderedTrades, narrative);
}
