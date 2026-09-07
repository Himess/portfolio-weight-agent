/**
 * §7.2 — Execution path: "which legs, in what order?"
 *
 * The model selects, orders, drops, and picks an execution method. It cannot
 * invent a trade or change a quantity: every returned candidateId is looked up
 * in the deterministic candidate set, and the quantity is taken from there.
 * Anything the model says about size is discarded.
 */

import type {
  CandidateTrade,
  ExecutionDecision,
  OrderedTrade,
  RebalanceContext,
} from "../types";
import { suggestMethod } from "../core/candidates";
import { logDecision } from "./client";
import { providerAvailable, structuredCall } from "./provider";
import { ExecutionSchema } from "./schemas";

const SYSTEM = `You choose how to execute an already-decided set of trades.

The trades and their quantities are fixed. You may:
- order them,
- drop one that is not worth executing,
- choose an execution method per trade.

You may NOT change a quantity, invent a trade, or reference an id that is not in
the candidates list.

Choosing the method is a real decision, and "slippageBps" is what it turns on.
That figure is measured — the order book was walked to this trade's size — and
it is what crossing the spread costs right now.

- spot_market — crosses immediately. Right when slippageBps is small: a couple
  of basis points is cheaper than the risk of not filling, and an unfilled
  order leaves the drift in place. The common case on a deep book.
- spot_limit  — rests inside the touch. Right when slippageBps is large, which
  means a thin book or a size that walks several levels. That slippage is
  exactly what resting avoids, so there it is real money. limitPriceOffsetBps
  is how far inside the touch to sit; positive is more passive, so a BUY rests
  below mid and a SELL above. Keep it well under slippageBps or it will not
  fill. The cost is fill risk — say so in "why".
- convert     — Binance Convert. For small notionals where crossing a thin book
  costs more than Convert's spread. Set limitPriceOffsetBps to 0.

Each candidate carries a "suggested" method computed from its own measured
book. Follow it unless something about the wider plan argues otherwise —
funding order, a leg you are dropping, an unusually urgent correction. If you
deviate, say why in "why". Do not deviate silently.

A plan can mix methods, and usually should when one asset is liquid and another
is not.

Hard ordering rule: every SELL must come before every BUY. Buys are funded by the
proceeds of sells, so this is not a preference.

Drop a candidate when its cost is out of proportion to the drift it fixes, or
when the book was exhausted and the fill would be bad. Explain each drop in one
short sentence.

"why" is one clause naming the figure that decided it — "book is deep, crossing
costs almost nothing", "thin book, resting saves most of the spread". Never "as
per the strategy".`;

/** Deterministic default: take every candidate at market, in the given order. */
export function deterministicExecution(
  candidates: CandidateTrade[],
  reason: string,
): ExecutionDecision {
  return {
    orderedTrades: candidates.map((c) => {
      // The book's own answer, so a fallback is not automatically the worse
      // execution — it simply has no judgment layered on top of the numbers.
      const s = suggestMethod(c);
      return {
        candidateId: c.id,
        method: s.method,
        limitPriceOffsetBps: s.limitPriceOffsetBps,
        why: `${s.because} — deterministic default.`,
      };
    }),
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
  if (!providerAvailable()) {
    return deterministicExecution(candidates, "no LLM provider configured");
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
      // Precomputed so it is not arithmetic the model has to do, and would do
      // badly: what crossing costs against the fee it pays either way.
      feeBps: Number(((c.estFeeUsd / Math.max(c.estNotionalUsd, 1)) * 10_000).toFixed(1)),
      bookExhausted: c.bookExhausted,
      convertAvailable: true,
      // What the measured book implies. The prompt described this rule and a
      // small model read 13.9bps of slippage and chose market anyway, so the
      // comparison is done here and offered as a choice rather than a sum.
      suggested: suggestMethod(c),
    })),
  };

  try {
    const res = await structuredCall({
      schema: ExecutionSchema,
      schemaName: "execution_decision",
      system: SYSTEM,
      facts,
      // A decision, not prose — identical facts must give an identical answer.
      temperature: 0,
      maxTokens: 2000,
    });

    if (!res.ok) return deterministicExecution(candidates, res.reason);
    const parsed = res.value;

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
