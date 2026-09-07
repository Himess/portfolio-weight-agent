/**
 * What a typed instruction is allowed to do.
 *
 * The chat surface exists so someone can say "BTC 40, add SUI at 10, track
 * tighter" instead of clicking through four controls. The model's only job
 * there is turning that sentence into edits from the fixed list below; every
 * edit is then applied *here*, by arithmetic, against the live tradable
 * universe.
 *
 * That split is the whole safety story. The model cannot invent a symbol that
 * does not trade, cannot produce weights that fail validation, cannot touch
 * anything outside an allocation, and — most importantly — cannot place an
 * order. The worst a misread instruction can do is change a number on a form
 * the owner is looking at.
 *
 * Pure. No I/O, no LLM.
 */

import type { Target } from "../types";

export type Edit =
  | { op: "set"; symbol: string; weightPct: number }
  | { op: "add"; symbol: string; weightPct: number }
  | { op: "remove"; symbol: string };

export type Applied = {
  op: Edit["op"];
  symbol: string;
  /** Weight before, in percent. Null when the leg did not exist. */
  fromPct: number | null;
  /** Weight after, in percent. Null when the leg was removed. */
  toPct: number | null;
};

export type Rejected = { edit: Edit; why: string };

export type ApplyResult = {
  targets: Target[];
  applied: Applied[];
  rejected: Rejected[];
  /** Total weight after, in percent — the UI already knows what to do with it. */
  totalPct: number;
  /** How much was taken from or returned to the cash leg, in percentage points. */
  cashDeltaPp: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function weightOf(targets: Target[], symbol: string): number | null {
  const t = targets.find((x) => x.kind === "asset" && x.symbol === symbol);
  return t ? t.weight * 100 : null;
}

/**
 * Apply a list of edits to an allocation.
 *
 * Cash absorbs the difference wherever it can. Someone who says "add SUI at
 * 10%" means "and take it from the money doing nothing", not "leave me 10
 * points over and refuse to continue" — but cash is never pushed below zero,
 * and whatever it could not absorb is left visible in `totalPct` rather than
 * quietly rescaling the legs the owner just set.
 */
export function applyEdits(
  targets: Target[],
  edits: Edit[],
  opts: { cashSymbol: string; tradable: Set<string> },
): ApplyResult {
  const out: Target[] = targets.map((t) => ({ ...t }));
  const applied: Applied[] = [];
  const rejected: Rejected[] = [];

  const cashBefore = weightOf(out, opts.cashSymbol) ?? 0;

  for (const edit of edits) {
    const symbol = edit.symbol.trim().toUpperCase();

    if (symbol === opts.cashSymbol && edit.op === "remove") {
      rejected.push({ edit, why: `${symbol} is the cash leg and cannot be removed.` });
      continue;
    }

    const index = out.findIndex((t) => t.kind === "asset" && t.symbol === symbol);
    const basket = out.find(
      (t): t is Extract<Target, { kind: "basket" }> =>
        t.kind === "basket" && t.label.toUpperCase() === symbol,
    );

    if (basket && edit.op !== "remove") {
      // Baskets are pinned deliberately; changing their weight is fine, but it
      // has to go through the basket path so `resolvedAt` semantics are clear.
      const before = basket.weight * 100;
      if (edit.op === "set" || edit.op === "add") {
        basket.weight = round2(edit.weightPct) / 100;
        applied.push({ op: edit.op, symbol: basket.label, fromPct: before, toPct: edit.weightPct });
      }
      continue;
    }

    if (edit.op === "remove") {
      const bIndex = out.findIndex((t) => t.kind === "basket" && t.label.toUpperCase() === symbol);
      const target = index >= 0 ? index : bIndex;
      if (target < 0) {
        rejected.push({ edit, why: `${symbol} is not in the allocation.` });
        continue;
      }
      const removed = out[target];
      applied.push({
        op: "remove",
        symbol: removed.kind === "asset" ? removed.symbol : removed.label,
        fromPct: removed.weight * 100,
        toPct: null,
      });
      out.splice(target, 1);
      continue;
    }

    // set / add both need a real, tradable symbol and a sane weight.
    if (symbol !== opts.cashSymbol && opts.tradable.size > 0 && !opts.tradable.has(symbol)) {
      rejected.push({ edit, why: `${symbol} does not trade against ${opts.cashSymbol} on Binance.` });
      continue;
    }
    if (!Number.isFinite(edit.weightPct) || edit.weightPct <= 0 || edit.weightPct > 100) {
      rejected.push({ edit, why: `A weight of ${edit.weightPct}% is not a weight.` });
      continue;
    }

    const weightPct = round2(edit.weightPct);
    if (index >= 0) {
      const before = round2(out[index].weight * 100);
      out[index] = { ...out[index], weight: weightPct / 100 } as Target;
      // A weight set to what it already was is not a change. Listing it as one
      // makes the transcript claim work it did not do.
      if (before !== weightPct) {
        applied.push({ op: edit.op, symbol, fromPct: before, toPct: weightPct });
      }
    } else {
      out.push({ kind: "asset", symbol, weight: weightPct / 100 });
      applied.push({ op: "add", symbol, fromPct: null, toPct: weightPct });
    }
  }

  // Let cash absorb whatever the edits cost, as far as it can.
  const nonCash = out
    .filter((t) => !(t.kind === "asset" && t.symbol === opts.cashSymbol))
    .reduce((sum, t) => sum + t.weight * 100, 0);

  const cashIndex = out.findIndex((t) => t.kind === "asset" && t.symbol === opts.cashSymbol);
  let cashAfter = cashBefore;

  if (cashIndex >= 0) {
    // Only touch cash if the owner did not just set it themselves.
    const cashWasEdited = applied.some((a) => a.symbol === opts.cashSymbol);
    if (!cashWasEdited) {
      cashAfter = Math.max(0, round2(100 - nonCash));
      out[cashIndex] = { ...out[cashIndex], weight: cashAfter / 100 } as Target;
    } else {
      cashAfter = out[cashIndex].weight * 100;
    }
  }

  const totalPct = round2(out.reduce((sum, t) => sum + t.weight * 100, 0));

  return {
    targets: out,
    applied,
    rejected,
    totalPct,
    cashDeltaPp: round2(cashAfter - cashBefore),
  };
}

/** One line per change, for the transcript. Deterministic — never model prose. */
export function describeApplied(a: Applied, cashSymbol: string): string {
  if (a.op === "remove") return `Removed ${a.symbol} (was ${a.fromPct?.toFixed(0)}%)`;
  if (a.fromPct == null) return `Added ${a.symbol} at ${a.toPct?.toFixed(0)}%`;
  if (a.symbol === cashSymbol) return `${cashSymbol} set to ${a.toPct?.toFixed(0)}%`;
  return `${a.symbol} ${a.fromPct.toFixed(0)}% → ${a.toPct?.toFixed(0)}%`;
}
