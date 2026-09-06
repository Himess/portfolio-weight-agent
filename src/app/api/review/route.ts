import { NextResponse } from "next/server";

import { runReview } from "@/agent";
import { ReplayAdapter } from "@/adapters/replay";
import { flattenTargets, validateAllocation } from "@/core/allocation";
import { ReviewRequestSchema } from "@/lib/api-contracts";
import { badRequest, failure } from "@/server/respond";
import { mcpBalances, publicAdapter, replayAdapter, statusFor } from "@/server/session";
import type { Allocation } from "@/types";

/** Buy the target allocation exactly, at a given replay bar. */
async function seedOnTarget(
  market: ReplayAdapter,
  allocation: Allocation,
  seedBar: number,
  navUsd: number,
): Promise<Record<string, number>> {
  market.seek(seedBar);
  const weights = flattenTargets(allocation);
  const prices = await market.getPrices(Object.keys(weights));

  const out: Record<string, number> = {};
  for (const [symbol, w] of Object.entries(weights)) {
    const price = symbol === allocation.cashSymbol ? 1 : prices[symbol];
    if (!price || price <= 0) continue;
    out[symbol] = (navUsd * w) / price;
  }
  return out;
}

export const runtime = "nodejs";
export const maxDuration = 120;

/** POST -> Proposal. Runs the full loop: drift -> candidates -> timing -> execution -> narrative. */
export async function POST(req: Request) {
  try {
    // Shape is enforced here, so nothing downstream has to re-check it.
    const body = ReviewRequestSchema.parse(await req.json());

    // Shape being right does not make the weights add up. That is a
    // separate question and the core owns it.
    const validation = validateAllocation(body.allocation);
    if (!validation.ok) return badRequest(validation.errors.join(" "));

    const source = body.source ?? "public";
    const market =
      source === "replay" ? await replayAdapter(body.dataset, body.bar) : publicAdapter();

    if (!market) {
      return badRequest("No replay dataset found. Run `npm run klines` first.");
    }

    let quantities = body.quantities ?? {};

    // Read real holdings from the connected account. Market data still comes
    // from the public API — see the note on mcpBalances.
    if (source === "mcp") {
      const holdings = await mcpBalances(body.allocation.cashSymbol);
      quantities = Object.fromEntries(holdings.map((h) => [h.symbol, h.qty]));
      if (Object.keys(quantities).length === 0) {
        return badRequest(
          "Your Agentic sub-account holds nothing yet. Fund it from Binance first — the agent cannot move funds into it.",
        );
      }
    }

    if (source === "replay" && body.seedBar != null && market instanceof ReplayAdapter) {
      quantities = await seedOnTarget(market, body.allocation, body.seedBar, body.seedNavUsd ?? 100_000);
      market.seek(body.bar ?? market.length - 1);
    }

    if (Object.keys(quantities).length === 0) {
      return badRequest("No holdings supplied. Enter quantities, or use replay with a seed bar.");
    }

    const proposal = await runReview({
      market,
      allocation: body.allocation,
      quantities,
      preference: body.preference,
      daysSinceLastRebalance: body.daysSinceLastRebalance,
    });

    // Real hourly closes for the sparklines. Never synthesised: a made-up
    // series on screen would be a number the user cannot trust (DESIGN.md §2).
    const symbols = proposal.context.portfolio.rows
      .map((r) => r.symbol)
      .filter((sym) => sym !== body.allocation.cashSymbol);

    const series: Record<string, number[]> = {};
    await Promise.all(
      symbols.map(async (sym) => {
        try {
          const kl = await market.getKlines(sym, "1h", 48);
          if (kl.length >= 3) series[sym] = kl.map((k) => k.close);
        } catch {
          /* a missing sparkline is fine; an invented one is not */
        }
      }),
    );

    return NextResponse.json({ proposal, status: statusFor(source), quantities, series });
  } catch (err) {
    return failure(err, "The review");
  }
}
