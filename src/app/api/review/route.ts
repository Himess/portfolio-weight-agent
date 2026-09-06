import { NextResponse } from "next/server";

import { runReview } from "@/agent";
import { ReplayAdapter } from "@/adapters/replay";
import { flattenTargets, validateAllocation } from "@/core/allocation";
import { publicAdapter, replayAdapter, statusFor } from "@/server/session";
import type { Allocation, Preference } from "@/types";

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

type Body = {
  allocation: Allocation;
  quantities?: Record<string, number>;
  preference?: Preference;
  daysSinceLastRebalance?: number | null;
  source?: "public" | "replay";
  dataset?: string;
  bar?: number;
  /**
   * Replay only: buy the target allocation exactly at this bar, then hold those
   * quantities while `bar` advances. This is how drift is produced for a demo —
   * the portfolio is untouched and the market moves under it.
   */
  seedBar?: number;
  seedNavUsd?: number;
};

/** POST -> Proposal. Runs the full loop: drift -> candidates -> timing -> execution -> narrative. */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const validation = validateAllocation(body.allocation);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.errors.join(" ") }, { status: 400 });
    }

    const source = body.source ?? "public";
    const market =
      source === "replay" ? await replayAdapter(body.dataset, body.bar) : publicAdapter();

    if (!market) {
      return NextResponse.json(
        { error: "No replay dataset found. Run `npm run klines` first." },
        { status: 400 },
      );
    }

    let quantities = body.quantities ?? {};

    if (source === "replay" && body.seedBar != null && market instanceof ReplayAdapter) {
      quantities = await seedOnTarget(market, body.allocation, body.seedBar, body.seedNavUsd ?? 100_000);
      market.seek(body.bar ?? market.length - 1);
    }

    if (Object.keys(quantities).length === 0) {
      return NextResponse.json(
        { error: "No holdings supplied. Enter quantities, or use replay with a seed bar." },
        { status: 400 },
      );
    }

    const proposal = await runReview({
      market,
      allocation: body.allocation,
      quantities,
      preference: body.preference ?? "balanced",
      daysSinceLastRebalance: body.daysSinceLastRebalance ?? null,
    });

    return NextResponse.json({ proposal, status: statusFor(source), quantities });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Review failed." },
      { status: 500 },
    );
  }
}
