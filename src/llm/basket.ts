/**
 * §7.3 — Basket resolution: "what is an L1?"
 *
 * The user types a category; the agent turns it into symbols and defends the
 * choice. Two things are never trusted to the model:
 *
 *   1. Symbol existence — every returned symbol is checked against the live
 *      tradable universe and dropped if it is not there. Models are confident
 *      about tickers that were delisted or never existed.
 *   2. Weight arithmetic — weights are normalized only if they are already
 *      within tolerance of 1.0; a wildly wrong set is rejected outright rather
 *      than silently rescaled into something the user did not ask for.
 *
 * Once the user approves, the basket is PINNED (resolvedAt is set) and never
 * re-resolves on its own. Silent membership changes would destroy trust.
 */

import { normalizeMemberWeights } from "../core/allocation";
import type { BasketResolution } from "../types";
import { logDecision } from "./client";
import { providerAvailable, structuredCall } from "./provider";
import { BasketSchema } from "./schemas";

const SYSTEM = `You turn a category a person typed into a concrete basket of tradable crypto assets.

You are given the category phrase and a list of assets that are actually
tradable, each with its 24h quote volume in USD. You may ONLY choose from that
list. If an asset you would expect is absent, it is not tradable here — say so in
"excluded" rather than naming it as a member.

Weighting: return intra-basket weights that sum to exactly 1.0. Prefer weighting
by relative significance within the category, moderated by liquidity — a thin
asset should not carry a large weight even if it fits the theme well. Round to
two decimals and make them sum to 1.00.

Size: 3 to 8 members. A basket of one is not a basket; a basket of twenty is an
index the user cannot reason about.

For each member, "why" is one short clause saying why it belongs — the specific
reason, not a restatement of the category.

Use "excluded" for assets a knowledgeable person would expect in this category
but that you deliberately left out, with the reason (too illiquid, better fits
another category, wrapped/duplicate exposure, not actually in this category).
This is how the user checks your judgment, so it matters.

Set confidence:
- high   — the category is well defined and the membership is uncontroversial.
- medium — the category is real but the boundary is arguable.
- low    — the phrase is vague, or you are unsure it denotes a real category.

Be honest at low confidence. The user reviews and edits this before anything is
saved, so an honest "this phrase is ambiguous" is more useful than a confident
guess.`;

export type BasketInput = {
  phrase: string;
  /** Base symbols tradable against the cash asset */
  tradable: string[];
  /** 24h quote volume in USD, keyed by base symbol */
  volumes: Record<string, number>;
  /** How many of the most liquid names to offer the model */
  universeSize?: number;
};

export async function resolveBasket(input: BasketInput): Promise<BasketResolution> {
  if (!providerAvailable()) {
    return failed("no LLM provider configured — enter the basket members manually");
  }

  const universe = [...input.tradable]
    .filter((s) => (input.volumes[s] ?? 0) > 0)
    .sort((a, b) => (input.volumes[b] ?? 0) - (input.volumes[a] ?? 0))
    .slice(0, input.universeSize ?? 180);

  const tradableSet = new Set(universe);

  const facts = {
    category: input.phrase,
    tradableAssets: universe.map((s) => ({
      symbol: s,
      quoteVolume24hUsd: Math.round(input.volumes[s] ?? 0),
    })),
  };

  try {
    const res = await structuredCall({
      schema: BasketSchema,
      schemaName: "basket_resolution",
      system: SYSTEM,
      facts,
      temperature: 0.2,
      maxTokens: 3000,
    });

    if (!res.ok) return failed(res.reason);
    const parsed = res.value;

    // Rule 1 — symbol existence is ours to decide, not the model's.
    const dropped: { symbol: string; why: string }[] = [];
    const members = parsed.members.filter((m) => {
      const ok = tradableSet.has(m.symbol);
      if (!ok) {
        dropped.push({
          symbol: m.symbol,
          why: `Dropped automatically: ${m.symbol} is not tradable against the cash asset here.`,
        });
      }
      return ok;
    });

    if (members.length === 0) {
      return failed("model returned no tradable symbols for this category");
    }

    // Rule 2 — normalize only within tolerance; otherwise reject.
    const normalized = normalizeMemberWeights(members);
    if (!normalized) {
      return failed(
        `model returned member weights summing to ${members
          .reduce((a, m) => a + m.weight, 0)
          .toFixed(3)}, too far from 1.0 to normalize`,
      );
    }

    logDecision(
      "basket",
      "ok",
      `"${input.phrase}" -> ${normalized.map((m) => m.symbol).join(", ")} (${parsed.confidence})`,
    );

    return {
      members: normalized,
      excluded: [...parsed.excluded, ...dropped],
      rationale: parsed.rationale,
      confidence: parsed.confidence,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logDecision("basket", "fallback", msg);
    return failed(msg);
  }
}

/**
 * There is no sensible deterministic default for "what is an L1" — the task is
 * entirely semantic. So the fallback is an honest empty result that routes the
 * user to manual entry, rather than a guess.
 */
function failed(reason: string): BasketResolution {
  return {
    members: [],
    excluded: [],
    rationale:
      "The category could not be resolved automatically. Add the assets you want in this basket by hand.",
    confidence: "low",
    fellBack: true,
    fallbackReason: reason,
  };
}
