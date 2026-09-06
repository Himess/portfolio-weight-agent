/**
 * Strict output schemas for the four LLM decisions — DESIGN.md §7.
 *
 * These are enforced twice:
 *   1. by the API, via zodOutputFormat in output_config.format
 *   2. by us, after parsing, against facts the model does not get to assert
 *      (which symbols were actually outside band, which candidate ids exist)
 *
 * The second check is the important one. Schema conformance only proves the
 * shape is right; it does not stop the model naming an asset we never flagged
 * or a trade we never generated.
 */

import { z } from "zod";

// §7.1 — Timing
export const TimingSchema = z.object({
  action: z.enum(["REBALANCE", "PARTIAL", "HOLD"]),
  assetsToActOn: z.array(z.string()),
  reasoning: z.string(),
  primaryFactor: z.enum([
    "cost",
    "volatility",
    "falling_knife",
    "drift_magnitude",
    "staleness",
  ]),
});
export type TimingOutput = z.infer<typeof TimingSchema>;

// §7.2 — Execution path
export const ExecutionSchema = z.object({
  orderedTrades: z.array(
    z.object({
      candidateId: z.string(),
      method: z.enum(["spot_market", "spot_limit", "convert"]),
      limitPriceOffsetBps: z.number(),
      why: z.string(),
    }),
  ),
  droppedCandidates: z.array(
    z.object({ candidateId: z.string(), why: z.string() }),
  ),
});
export type ExecutionOutput = z.infer<typeof ExecutionSchema>;

// §7.3 — Basket resolution
export const BasketSchema = z.object({
  members: z.array(
    z.object({ symbol: z.string(), weight: z.number(), why: z.string() }),
  ),
  excluded: z.array(z.object({ symbol: z.string(), why: z.string() })),
  rationale: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});
export type BasketOutput = z.infer<typeof BasketSchema>;

// §7.4 — Narrative
export const NarrativeSchema = z.object({
  headline: z.string(),
  body: z.string(),
});
export type NarrativeOutput = z.infer<typeof NarrativeSchema>;
