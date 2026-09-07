import { NextResponse } from "next/server";

import { ExplainRequestSchema } from "@/lib/api-contracts";
import { explainDecision } from "@/llm/explain";
import { BASKET_LIMIT, rateLimit } from "@/server/guard";
import { failure } from "@/server/respond";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/explain — one question about a decision already made.
 *
 * Separate from /api/command on purpose. That route routes an instruction: it
 * can edit the allocation, change the tracking preference, or start a review,
 * so it has to decide what the sentence was. Here the sentence is always a
 * question about the plan on screen, so there is nothing to route — and no path
 * from a question to a changed portfolio, which is the property worth having on
 * a screen someone is reading rather than editing.
 *
 * It cannot trade either. Nothing in this file writes anything.
 */
export async function POST(req: Request) {
  // A model call per question, on the same budget as the other typed surfaces.
  const limited = rateLimit(req, "explain", BASKET_LIMIT);
  if (limited) return limited;

  try {
    const body = ExplainRequestSchema.parse(await req.json());
    return NextResponse.json({ say: await explainDecision(body.question, body.facts) });
  } catch (err) {
    return failure(err, "That question");
  }
}
