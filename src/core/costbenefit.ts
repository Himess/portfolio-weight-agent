/**
 * Cost/benefit — DESIGN.md §6.
 *
 *   estimatedCostUsd = Σ (fee_i + slippage_i)
 *   driftReductionPp = totalDrift_before - totalDrift_after
 *   costPerPpUsd     = estimatedCostUsd / max(driftReductionPp, 0.01)
 *
 * costPerPpUsd is the number the timing decision leans on hardest: it is the
 * price of one percentage point of correction. When it is high relative to the
 * portfolio, the cure costs more than the disease.
 */

import type { CandidateTrade, CostBenefit, PortfolioState } from "../types";
import { deltasFromTrades } from "./candidates";
import { projectDriftAfter } from "./drift";

export function computeCostBenefit(
  state: PortfolioState,
  trades: CandidateTrade[],
): CostBenefit {
  const estimatedCostUsd = trades.reduce(
    (sum, t) => sum + t.estFeeUsd + t.estSlippageUsd,
    0,
  );

  const totalDriftBeforePp = state.totalDriftPp;
  const totalDriftAfterPp = projectDriftAfter(state, deltasFromTrades(trades));
  const driftReductionPp = totalDriftBeforePp - totalDriftAfterPp;

  return {
    estimatedCostUsd,
    totalDriftBeforePp,
    totalDriftAfterPp,
    driftReductionPp,
    costPerPpUsd: estimatedCostUsd / Math.max(driftReductionPp, 0.01),
    costBps: state.navUsd > 0 ? (estimatedCostUsd / state.navUsd) * 10_000 : 0,
  };
}
