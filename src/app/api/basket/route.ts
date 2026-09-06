import { NextResponse } from "next/server";

import { BasketRequestSchema } from "@/lib/api-contracts";
import { BASKET_LIMIT, rateLimit } from "@/server/guard";
import { failure } from "@/server/respond";
import { publicAdapter } from "@/server/session";
import { resolveBasket } from "@/llm/basket";

export const runtime = "nodejs";
export const maxDuration = 60;

/** POST { phrase } -> BasketResolution (§7.3) */
export async function POST(req: Request) {
  const limited = rateLimit(req, "basket", BASKET_LIMIT);
  if (limited) return limited;

  try {
    const { phrase } = BasketRequestSchema.parse(await req.json());

    const adapter = publicAdapter();
    const [tradable, volumes] = await Promise.all([
      adapter.getTradableSymbols(),
      adapter.getQuoteVolumes(),
    ]);

    const resolution = await resolveBasket({ phrase, tradable, volumes });
    return NextResponse.json(resolution);
  } catch (err) {
    return failure(err, "Resolving the category");
  }
}
