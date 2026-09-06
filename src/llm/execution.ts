/**
 * §7.2 — Execution path: "which legs, in what order?"
 *
 * The model selects, orders, drops, and picks an execution method. It cannot
 * invent a trade or change a quantity: every returned candidateId is looked up
 * in the deterministic candidate set, and the quantity is taken from there.
 * Anything the model says about size is discarded.
 */

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import type {
  CandidateTrade,
  ExecutionDecision,
  OrderedTrade,
  RebalanceContext,
} from "../types";
import { MODEL, getClient, hasCredentials, logDecision, samplingFor } from "./client";
import { ExecutionSchema } from "./schemas";

const SYSTEM = `You choose how to execute an already-decided set of trades.

The trades and their quantities are fixed. You may:
- order them,
- drop one that is not worth executing,
- choose an execution method per trade.

You may NOT change a quantity, invent a trade, or reference an id that is not in
the candidates list.

Methods:
- spot_market — immediate fill at the touch. Use when slippage is low and the
  trade should just get done.
- spot_limit  — a resting order at an offset. Use when slippageBps is high or the
  book is thin, and a few basis points are worth waiting for. Set
  limitPriceOffsetBps to how far inside the touch to sit (positive = more
  passive, so a BUY sits below mid and a SELL above). Keep it under 50.
- convert     — Binance Convert. Use for small notionals where the spread is
  better than crossing a thin book. Set limitPriceOffsetBps to 0.

Hard ordering rule: every SELL must come before every BUY. Buys are funded by the
proceeds of sells, so this is not a preference.

Drop a candidate when its cost is out of proportion to the drift it fixes, or
when the book was exhausted and the fill would be bad. Explain each drop in one
short sentence. Use spot_market for everything if nothing suggests otherwise —
do not manufacture complexity.`;

/** Deterministic default: take every candidate at market, in the given order. */
export function deterministicExecution(
  candidates: CandidateTrade[],
  reason: string,
): ExecutionDecision {
  return {
    orderedTrades: candidates.map((c) => ({
      candidateId: c.id,
      method: "spot_market" as const,
      limitPriceOffsetBps: 0,
      why: "Market order — deterministic default.",
    })),
    droppedCandidates: [],
    fellBack: true,
    fallbackReason: reason,
  };
}

export async function decideExecution(
  ctx: RebalanceContext,
  candidates: CandidateTrade[],
): Promise<ExecutionDecision> {
  if (candidates.length === 0) {
    return { orderedTrades: [], droppedCandidates: [] };
  }
  if (!hasCredentials()) {
    return deterministicExecution(candidates, "no ANTHROPIC_API_KEY configured");
  }

  const facts = {
    navUsd: Number(ctx.portfolio.navUsd.toFixed(2)),
    cashSymbol: ctx.cashSymbol,
    availableCashUsd: Number(
      (ctx.portfolio.rows.find((r) => r.symbol === ctx.cashSymbol)?.currentValueUsd ?? 0).toFixed(2),
    ),
    candidates: candidates.map((c) => ({
      id: c.id,
      side: c.side,
      symbol: c.symbol,
      pair: c.pair,
      qty: c.qty,
      estNotionalUsd: Number(c.estNotionalUsd.toFixed(2)),
      estFeeUsd: Number(c.estFeeUsd.toFixed(2)),
      estSlippageUsd: Number(c.estSlippageUsd.toFixed(2)),
      slippageBps: Number(c.slippageBps.toFixed(1)),
      bookExhausted: c.bookExhausted,
      convertAvailable: true,
    })),
  };

  try {
    const res = await getClient().messages.parse({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      ...samplingFor("analytical"),
      messages: [{ role: "user", content: JSON.stringify(facts, null, 2) }],
      output_config: { format: zodOutputFormat(ExecutionSchema) },
    });

    const parsed = res.parsed_output;
    if (!parsed) return deterministicExecution(candidates, "model returned no parseable output");

    const byId = new Map(candidates.map((c) => [c.id, c]));

    // Every referenced id must exist. A hallucinated id invalidates the answer.
    const unknown = [
      ...parsed.orderedTrades.map((t) => t.candidateId),
      ...parsed.droppedCandidates.map((t) => t.candidateId),
    ].filter((id) => !byId.has(id));

    if (unknown.length > 0) {
      return deterministicExecution(
        candidates,
        `model referenced unknown candidate ids: ${[...new Set(unknown)].join(", ")}`,
      );
    }

    // No duplicates, and no trade both kept and dropped.
    const kept = parsed.orderedTrades.map((t) => t.candidateId);
    const dropped = new Set(parsed.droppedCandidates.map((t) => t.candidateId));
    if (new Set(kept).size !== kept.length) {
      return deterministicExecution(candidates, "model repeated a candidate id");
    }
    if (kept.some((id) => dropped.has(id))) {
      return deterministicExecution(candidates, "model both kept and dropped the same candidate");
    }

    // Sells before buys is a hard invariant, not a suggestion. If the model
    // broke it, we keep its selections and drops but restore a safe order.
    const orderedTrades = [...parsed.orderedTrades].sort((a, b) => {
      const ca = byId.get(a.candidateId)!;
      const cb = byId.get(b.candidateId)!;
      if (ca.side !== cb.side) return ca.side === "SELL" ? -1 : 1;
      return cb.estNotionalUsd - ca.estNotionalUsd;
    });

    logDecision(
      "execution",
      "ok",
      `${orderedTrades.length} kept, ${parsed.droppedCandidates.length} dropped`,
    );

    return {
      orderedTrades: orderedTrades.map((t) => ({
        ...t,
        limitPriceOffsetBps: clampBps(t.limitPriceOffsetBps),
      })),
      droppedCandidates: parsed.droppedCandidates,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logDecision("execution", "fallback", msg);
    return deterministicExecution(candidates, msg);
  }
}

function clampBps(bps: number): number {
  if (!Number.isFinite(bps)) return 0;
  return Math.max(0, Math.min(50, bps));
}

/**
 * Materialize the decision into orders. Quantities come from the deterministic
 * candidate — never from the model.
 */
export function materializeTrades(
  decision: ExecutionDecision,
  candidates: CandidateTrade[],
): OrderedTrade[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: OrderedTrade[] = [];

  decision.orderedTrades.forEach((t, i) => {
    const c = byId.get(t.candidateId);
    if (!c) return;
    out.push({
      ...c,
      sequenceIndex: i,
      method: t.method,
      limitPriceOffsetBps: t.limitPriceOffsetBps,
      why: t.why,
    });
  });

  return out;
}
