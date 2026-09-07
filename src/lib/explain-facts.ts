/**
 * The decision, reduced to what a question about it can be answered from.
 *
 * The web surface keeps the proposal client-side — there is no server session
 * holding a portfolio — so asking "why didn't you sell AVAX?" has to carry the
 * decision along with the question. Sending the whole `Proposal` back up would
 * work and is the wrong shape: the explain path prints figures, and it is worth
 * being able to read, in one place, the complete list of things it can print.
 *
 * So this is a projection, not a serialisation. Everything the answer may quote
 * is here; anything absent cannot appear in an answer, whatever the model says.
 *
 * The per-position `actedOn` / `declined` flags are the point of it. A verdict
 * alone cannot answer a question about one leg — PARTIAL means "some of them" —
 * and the flags are what turn "why AVAX" into an answer about AVAX.
 */

import type { ExplainFacts } from "./api-contracts";
import type { Proposal } from "../types";

export function explainFactsFrom(p: Proposal): ExplainFacts {
  const signal = new Map(p.context.signals.map((s) => [s.symbol, s]));
  const traded = new Set(p.orderedTrades.map((t) => t.symbol));
  const declined = new Set(p.declined.map((c) => c.symbol));

  return {
    verdict: p.timing.action,
    primaryFactor: p.timing.primaryFactor,
    reasoning: p.timing.reasoning,
    navUsd: p.context.portfolio.navUsd,
    totalDriftPp: p.context.portfolio.totalDriftPp,
    daysSinceLastRebalance: p.context.daysSinceLastRebalance,
    costBenefit: {
      estimatedCostUsd: p.context.costBenefit.estimatedCostUsd,
      driftReductionPp: p.context.costBenefit.driftReductionPp,
      costPerPpUsd: p.context.costBenefit.costPerPpUsd,
    },
    // Cash is dropped: it has no signals, it is never traded as a leg, and a
    // question about it is a question about the positions around it.
    rows: p.context.portfolio.rows
      .filter((r) => r.symbol !== p.context.cashSymbol)
      .map((r) => {
        const s = signal.get(r.symbol);
        return {
          symbol: r.symbol,
          targetWeight: r.targetWeight,
          currentWeight: r.currentWeight,
          driftPp: r.driftPp,
          bandPp: r.bandPp,
          deltaUsd: r.deltaUsd,
          outsideBand: r.outsideBand,
          actedOn: traded.has(r.symbol),
          declined: declined.has(r.symbol),
          priceChange4hPct: s?.priceChange4hPct ?? null,
          priceChange24hPct: s?.priceChange24hPct ?? null,
          volRatio: s?.volRatio ?? null,
        };
      }),
    trades: p.orderedTrades.map((t) => ({
      side: t.side,
      symbol: t.symbol,
      qty: t.qty,
      estNotionalUsd: t.estNotionalUsd,
    })),
  };
}
