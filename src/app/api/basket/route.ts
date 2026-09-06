import { NextResponse } from "next/server";

import { publicAdapter } from "@/server/session";
import { resolveBasket } from "@/llm/basket";

export const runtime = "nodejs";
export const maxDuration = 60;

/** POST { phrase } -> BasketResolution (§7.3) */
export async function POST(req: Request) {
  try {
    const { phrase } = (await req.json()) as { phrase?: string };
    if (!phrase || !phrase.trim()) {
      return NextResponse.json({ error: "A category phrase is required." }, { status: 400 });
    }

    const adapter = publicAdapter();
    const [tradable, volumes] = await Promise.all([
      adapter.getTradableSymbols(),
      adapter.getQuoteVolumes(),
    ]);

    const resolution = await resolveBasket({ phrase: phrase.trim(), tradable, volumes });
    return NextResponse.json(resolution);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Basket resolution failed." },
      { status: 500 },
    );
  }
}
