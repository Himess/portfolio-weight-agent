import { NextResponse } from "next/server";

import { validateAllocation } from "@/core/allocation";
import { applyEdits, describeApplied, type Edit } from "@/core/commands";
import { routeCommand } from "@/llm/command";
import { explainDecision } from "@/llm/explain";
import { findBareFigures } from "@/llm/narrative";
import { CommandRequestSchema } from "@/lib/api-contracts";
import { BASKET_LIMIT, rateLimit } from "@/server/guard";
import { failure } from "@/server/respond";
import { publicAdapter } from "@/server/session";

/** Used when the model put figures in its acknowledgement — see below. */
const NEUTRAL: Record<string, string> = {
  edit: "Done — the changes are listed below.",
  set_preference: "Tracking preference updated.",
  add_basket: "Resolving that category now.",
  review: "Running the review.",
  unsupported: "I cannot do that from here.",
};

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/command — one typed instruction.
 *
 * The model chooses an intent; this route applies it. Nothing the model returns
 * reaches the allocation without going through `applyEdits`, which checks every
 * symbol against the live exchange and every weight against arithmetic.
 *
 * There is no intent that trades. The response can change the form in front of
 * the owner and nothing else.
 */
export async function POST(req: Request) {
  // An LLM call per message; the same budget as basket resolution.
  const limited = rateLimit(req, "command", BASKET_LIMIT);
  if (limited) return limited;

  try {
    const body = CommandRequestSchema.parse(await req.json());

    let tradable: string[] = [];
    try {
      tradable = await publicAdapter().getTradableSymbols();
    } catch {
      // Without the universe, symbol checking is skipped rather than guessed —
      // applyEdits treats an empty set as "cannot verify" and lets it through,
      // and the review will fail loudly if the symbol is not real.
    }

    const routed = await routeCommand({
      message: body.message,
      allocation: body.allocation,
      preference: body.preference,
      tradable,
      hasProposal: body.hasProposal,
    });

    // The same rule as the narrative layer: the model does not get to invent
    // figures. Echoing one the owner just typed is not inventing it, though —
    // "add SUI at 10%" should be able to answer "adding SUI at 10%" — so a
    // figure that appears verbatim in the instruction is allowed through. Only
    // a number that came from nowhere is stripped.
    const said = new Set(findBareFigures(body.message).map((f) => f.replace(/\s+/g, "")));
    const bare = findBareFigures(routed.say).filter((f) => !said.has(f.replace(/\s+/g, "")));
    const say =
      bare.length === 0
        ? routed.say
        : NEUTRAL[routed.intent] ?? "Done — the change is shown below.";

    const base = {
      intent: routed.intent,
      say,
      ...(bare.length > 0 ? { strippedFigures: bare } : {}),
      ...(routed.fellBack ? { fellBack: true, fallbackReason: routed.fallbackReason } : {}),
    };

    // A preference can ride along with an edit: people say "remove SUI, add TAO
    // at 12, and track more closely" in one breath. Applying only the edits
    // while the model's sentence claimed both was the model telling the truth
    // about its intent and the app quietly ignoring half of it.
    const alsoPreference = routed.preference ?? null;

    if (routed.intent === "edit") {
      const edits: Edit[] = [];
      for (const e of routed.edits) {
        if (e.op === "remove") edits.push({ op: "remove", symbol: e.symbol });
        else if (e.weightPct != null) edits.push({ op: e.op, symbol: e.symbol, weightPct: e.weightPct });
      }

      const result = applyEdits(body.allocation.targets, edits, {
        cashSymbol: body.allocation.cashSymbol,
        tradable: new Set(tradable),
      });

      const allocation = { targets: result.targets, cashSymbol: body.allocation.cashSymbol };
      const check = validateAllocation(allocation);
      return NextResponse.json({
        ...base,
        targets: result.targets,
        // Rendered from what actually happened, never from the model's prose.
        changes: result.applied.map((a) => describeApplied(a, body.allocation.cashSymbol)),
        rejected: result.rejected.map((r) => r.why),
        totalPct: result.totalPct,
        cashDeltaPp: result.cashDeltaPp,
        valid: check.ok,
        ...(alsoPreference ? { preference: alsoPreference } : {}),
        // The actual first problem, not a guess about the total. Saying "totals
        // 100.0% — adjust a weight" while it totals 100.0% is how a user stops
        // believing the messages.
        ...(check.ok ? {} : { problem: check.errors[0] }),
      });
    }

    if (routed.intent === "set_preference" && routed.preference) {
      return NextResponse.json({ ...base, preference: routed.preference });
    }

    if (routed.intent === "add_basket") {
      // Handed back to the client, which already owns the basket flow: resolve,
      // show the members, pin only on approval.
      const weightPct = routed.edits.find((e) => e.weightPct != null)?.weightPct ?? null;
      return NextResponse.json({ ...base, phrase: routed.phrase, weightPct });
    }

    // "Why didn't you sell AVAX?" — answered from the fact sheet the verdict was
    // made from, with figures substituted rather than typed. The router's own
    // acknowledgement is discarded here: it was written before the facts were
    // read, and two sentences about the same decision would disagree eventually.
    if (routed.intent === "explain") {
      // `base` carries the acknowledgement's own guard result; reporting a
      // figure stripped from a sentence nobody sees would be noise.
      const shell = {
        intent: routed.intent,
        ...(routed.fellBack ? { fellBack: true, fallbackReason: routed.fallbackReason } : {}),
      };
      if (!body.facts) {
        return NextResponse.json({
          ...shell,
          say: "There is no decision to explain yet — run a review and ask again.",
        });
      }
      return NextResponse.json({
        ...shell,
        say: await explainDecision(body.message, body.facts),
        answered: true,
      });
    }

    return NextResponse.json({ ...base, phrase: routed.phrase });
  } catch (err) {
    return failure(err, "That instruction");
  }
}
