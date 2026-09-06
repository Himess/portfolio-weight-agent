/**
 * Allocation validation and flattening — DESIGN.md §4.
 *
 * Invariant: all target weights sum to exactly 1.0. Validated on input,
 * rejected otherwise. Baskets are flattened to effective per-symbol weights:
 * a basket at 20% NAV with members [SOL 0.5, AVAX 0.5] yields SOL 10%, AVAX 10%.
 */

import type { Allocation, Target, TargetBasket } from "../types";

/** Floating-point tolerance for "sums to 1". 1e-6 ≈ 0.0001pp. */
export const WEIGHT_EPSILON = 1e-6;

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function validateAllocation(alloc: Allocation): ValidationResult {
  const errors: string[] = [];

  if (alloc.targets.length === 0) {
    errors.push("Allocation has no targets.");
  }

  let total = 0;
  const seen = new Set<string>();

  for (const t of alloc.targets) {
    if (!Number.isFinite(t.weight) || t.weight < 0) {
      errors.push(`Target ${describe(t)} has an invalid weight: ${t.weight}`);
      continue;
    }
    if (t.weight === 0) {
      errors.push(`Target ${describe(t)} has zero weight — remove it instead.`);
    }
    total += t.weight;

    if (t.kind === "asset") {
      if (seen.has(t.symbol)) {
        errors.push(`Symbol ${t.symbol} appears more than once.`);
      }
      seen.add(t.symbol);
    } else {
      const basketErrors = validateBasket(t, seen);
      errors.push(...basketErrors);
    }
  }

  if (Math.abs(total - 1) > WEIGHT_EPSILON) {
    errors.push(
      `Target weights must sum to 1.0 (100%); they sum to ${(total * 100).toFixed(4)}%.`,
    );
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateBasket(b: TargetBasket, seen: Set<string>): string[] {
  const errors: string[] = [];
  if (b.members.length === 0) {
    errors.push(`Basket "${b.label}" has no members.`);
    return errors;
  }
  let inner = 0;
  for (const m of b.members) {
    if (!Number.isFinite(m.weight) || m.weight < 0) {
      errors.push(`Basket "${b.label}" member ${m.symbol} has an invalid weight.`);
      continue;
    }
    inner += m.weight;
    if (seen.has(m.symbol)) {
      errors.push(`Symbol ${m.symbol} appears more than once (in basket "${b.label}").`);
    }
    seen.add(m.symbol);
  }
  if (Math.abs(inner - 1) > WEIGHT_EPSILON) {
    errors.push(
      `Basket "${b.label}" member weights must sum to 1.0; they sum to ${inner.toFixed(6)}.`,
    );
  }
  return errors;
}

function describe(t: Target): string {
  return t.kind === "asset" ? t.symbol : `"${t.label}"`;
}

/**
 * Flatten an allocation to effective per-symbol weights of total NAV.
 * Basket members are multiplied by the basket's own weight.
 */
export function flattenTargets(alloc: Allocation): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of alloc.targets) {
    if (t.kind === "asset") {
      out[t.symbol] = (out[t.symbol] ?? 0) + t.weight;
    } else {
      for (const m of t.members) {
        out[m.symbol] = (out[m.symbol] ?? 0) + t.weight * m.weight;
      }
    }
  }
  return out;
}

/**
 * Normalize member weights to sum to 1, if they are within `tolerance` of it.
 * Returns null when they are too far off to be a rounding artifact — the caller
 * should reject rather than silently rescale a materially wrong answer.
 * Used on LLM basket output (DESIGN.md §7.3).
 */
export function normalizeMemberWeights(
  members: { symbol: string; weight: number; why?: string }[],
  tolerance = 0.05,
): { symbol: string; weight: number; why?: string }[] | null {
  const sum = members.reduce((a, m) => a + m.weight, 0);
  if (!Number.isFinite(sum) || sum <= 0) return null;
  if (Math.abs(sum - 1) > tolerance) return null;
  if (Math.abs(sum - 1) <= WEIGHT_EPSILON) return members;
  return members.map((m) => ({ ...m, weight: m.weight / sum }));
}

/** All symbols an allocation refers to, including basket members. */
export function allocationSymbols(alloc: Allocation): string[] {
  return Object.keys(flattenTargets(alloc));
}
