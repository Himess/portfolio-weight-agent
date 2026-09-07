/**
 * Turning a sentence into an instruction.
 *
 * This is the only place the product accepts free text as a *command* rather
 * than as a category phrase, so the boundary is drawn tightly: the model picks
 * one intent from a fixed list and fills in parameters. It does not apply
 * anything, it does not compute anything, and there is no intent that places an
 * order — the strongest thing a sentence can do here is change a number on a
 * form the owner is looking at, and `core/commands.ts` then checks that number
 * against the live tradable universe before it lands.
 *
 * The `say` field is one line of acknowledgement, and it is deliberately not
 * where results are reported. What actually changed is rendered from the
 * deterministic result, so a model that misdescribes its own edit cannot
 * mislead anyone: the screen shows "BTC 40% → 50%" because that is what
 * happened, not because the model said so.
 */

import type { Allocation, Preference } from "../types";
import { logDecision } from "./client";
import { providerAvailable, structuredCall } from "./provider";
import { CommandSchema, type CommandOutput } from "./schemas";

const SYSTEM = `You route one typed instruction from a portfolio owner into a single structured intent.

You never carry out the instruction and you never do arithmetic. Something else
applies your output, checks every symbol against the live exchange, and rejects
anything that does not hold up.

Pick exactly one intent:

- "edit"           — change the target allocation. Fill "edits" with one entry
                     per change. op "set" for an explicit weight, "add" for a
                     leg that is not there yet, "remove" to drop one. weightPct
                     is a percentage of the whole portfolio (10 means 10%), and
                     is null only for "remove".
- "set_preference" — how closely to track, when that is the whole instruction.
                     patient, balanced, tight, continuous.
- "add_basket"     — the owner named a *category* rather than tickers ("AI
                     tokens", "DeFi blue chips"). Put the category in "phrase";
                     put the intended weight in a single "edits" entry with op
                     "add" and the basket's weight, symbol "BASKET".
- "review"         — run the analysis now. "check my portfolio", "what should I
                     do", "any drift?"
- "explain"        — a question about the current state or the last decision.
                     Put the question in "phrase".
- "unsupported"    — anything else, and in particular ANY request to buy, sell,
                     place, cancel or approve an order, to move funds, or to
                     change something outside the target allocation. Say plainly
                     in "say" that this app proposes and the owner approves in
                     Binance, and that you cannot trade.

Rules that matter:

- A basket is addressed by its LABEL, exactly as shown in currentAllocation —
  "remove L1s" is one edit with symbol "L1s", not two edits for its members.
  The members are not top-level legs and removing them individually fails.
- Only use tickers from the tradable list you are given. If the owner names
  something that is not on it, do not substitute a similar one — return the
  symbol they said and let the checker reject it, or use "unsupported" and say
  it is not listed.
- "sell BTC" is not an edit. Reducing a target weight is an edit; selling is an
  order, and orders are "unsupported".
- Percentages are of the whole portfolio unless the owner clearly says otherwise.
  "make BTC half" is 50. "double BTC" is not a weight you can compute — return
  "unsupported" and ask for a number.
- Several changes in one sentence are several entries in "edits", in the order
  the owner said them.
- A sentence can carry both. "remove SUI, add TAO at 12, and track more closely"
  is intent "edit" with two entries AND "preference" set to tight — fill both.
  Only leave "preference" null when the owner did not mention tracking.

"say" is one short sentence of your own, addressed to the owner and written in
the language they used. Do not echo their instruction back at them — they just
typed it. Say what you understood them to want, in your words. Never claim an
edit succeeded; you do not know yet, and the result is shown separately.`;

export type CommandInput = {
  message: string;
  allocation: Allocation;
  preference: Preference;
  /** Base symbols tradable against the cash asset. */
  tradable: string[];
  /** Whether a proposal exists to ask questions about. */
  hasProposal: boolean;
};

export type RoutedCommand = CommandOutput & { fellBack?: boolean; fallbackReason?: string };

/** With no provider, the surface says so rather than guessing at intent. */
function unavailable(reason: string): RoutedCommand {
  return {
    intent: "unsupported",
    edits: [],
    preference: null,
    phrase: null,
    say: "The judgment layer is not available, so I cannot read that instruction. The controls on the left still work.",
    fellBack: true,
    fallbackReason: reason,
  };
}

export async function routeCommand(input: CommandInput): Promise<RoutedCommand> {
  if (!providerAvailable()) return unavailable("no provider configured");

  const facts = {
    instruction: input.message,
    currentAllocation: input.allocation.targets.map((t) =>
      t.kind === "asset"
        ? { symbol: t.symbol, weightPct: Math.round(t.weight * 1000) / 10 }
        : { basket: t.label, weightPct: Math.round(t.weight * 1000) / 10, members: t.members.map((m) => m.symbol) },
    ),
    cashSymbol: input.allocation.cashSymbol,
    trackingPreference: input.preference,
    aProposalExists: input.hasProposal,
    // Capped: the full universe is ~740 symbols and the instruction almost
    // always names something liquid. The checker sees the whole list anyway.
    tradableSymbols: input.tradable.slice(0, 400),
  };

  try {
    const res = await structuredCall({
      schema: CommandSchema,
      schemaName: "command",
      system: SYSTEM,
      facts,
      temperature: 0,
      maxTokens: 900,
    });

    if (!res.ok) {
      logDecision("command", "fallback", res.reason);
      return unavailable(res.reason);
    }

    logDecision("command", "ok", res.value.intent);
    return res.value;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logDecision("command", "fallback", reason);
    return unavailable(reason);
  }
}
