/**
 * When a watch is worth interrupting someone for.
 *
 * The threshold is not a new invention: a watch fires on exactly the same band
 * the app uses on screen — max(2pp, 25% of the target weight). Inventing a
 * second, quieter threshold for notifications would mean the alert and the app
 * disagreed about whether anything was wrong, and the user would learn to
 * distrust both.
 *
 * What this file adds is the part a screen does not need: silence. A portfolio
 * parked outside its band is outside it every hour, and an alert per hour is an
 * alert nobody reads. So a message goes out when the *situation* changes — a
 * different verdict, a different set of assets — and otherwise at most once per
 * repeat window.
 *
 * Pure. No I/O, no clock of its own; the caller passes `now`.
 */

import type { PortfolioState, TimingAction } from "../types";

/** What a scan concluded. `IN_BAND` is the deterministic no-LLM case. */
export type WatchVerdict = TimingAction | "IN_BAND";

export type WatchSignature = {
  verdict: WatchVerdict;
  /** Symbols outside their band, sorted — identity of the situation, not its size. */
  assets: string[];
};

/** Stable string form, so "has anything changed" is one comparison. */
export function signatureOf(sig: WatchSignature): string {
  return `${sig.verdict}:${[...sig.assets].sort().join(",")}`;
}

/** Which positions are outside their band, cash excluded. */
export function breachedSymbols(state: PortfolioState, cashSymbol: string): string[] {
  return state.rows
    .filter((r) => r.outsideBand && r.symbol !== cashSymbol)
    .map((r) => r.symbol)
    .sort();
}

export type NotifyInput = {
  signature: WatchSignature;
  lastSignature: string | null;
  lastNotifiedAt: string | null;
  repeatAfterHours: number;
  paused: boolean;
  bound: boolean;
  now: number;
  /** Timestamps of messages already sent, any age — filtered here. */
  sentAt?: string[];
  /** Messages a day this owner's setting treats as normal. */
  dailyAskBudget?: number;
};

/**
 * Did the situation get worse, or just change?
 *
 * A budget that suppressed everything once spent would eventually hide the one
 * message that mattered. An escalation always gets through: a new asset in
 * trouble, or the agent moving from "wait" to "act".
 */
function isEscalation(now: WatchSignature, last: string | null): boolean {
  if (last === null) return true;
  const [lastVerdict, lastAssets] = [last.slice(0, last.indexOf(":")), last.slice(last.indexOf(":") + 1)];
  const previous = new Set(lastAssets ? lastAssets.split(",") : []);
  if (now.assets.some((a) => !previous.has(a))) return true;
  // Waiting -> acting is the message the owner actually needs.
  return lastVerdict === "HOLD" && (now.verdict === "REBALANCE" || now.verdict === "PARTIAL");
}

export type NotifyDecision = {
  send: boolean;
  /** Why, in words — logged, and useful when someone asks "why did/didn't it ping me". */
  why: string;
};

/** Messages sent in the trailing 24 hours. */
export function sentLast24h(sentAt: string[] | undefined, now: number): number {
  if (!sentAt) return 0;
  const cutoff = now - 86_400_000;
  return sentAt.filter((t) => Date.parse(t) >= cutoff).length;
}

export function shouldNotify(input: NotifyInput): NotifyDecision {
  if (!input.bound) return { send: false, why: "no Telegram chat linked yet" };
  if (input.paused) return { send: false, why: "watch is paused" };

  const now = signatureOf(input.signature);
  const changed = now !== input.lastSignature;

  if (input.signature.verdict === "IN_BAND") {
    // The all-clear is only meaningful as the answer to an alert the user is
    // still holding open. A watch that has never reported a breach — including
    // a brand-new one, where lastSignature is null and everything therefore
    // looks "changed" — has nothing to close, so it says nothing.
    const wasBreached =
      input.lastSignature !== null && !input.lastSignature.startsWith("IN_BAND:");
    if (wasBreached) return { send: true, why: "returned inside its bands" };
    return { send: false, why: "still inside every band" };
  }

  if (changed) {
    // Attention is the scarce resource. On a violent day a portfolio can cross
    // and re-cross several bands in an afternoon, and every crossing is a
    // "change" — which would be six messages about one bad morning. Past the
    // day's budget only an escalation is worth interrupting for.
    const budget = input.dailyAskBudget;
    if (budget != null && sentLast24h(input.sentAt, input.now) >= budget) {
      if (!isEscalation(input.signature, input.lastSignature)) {
        return { send: false, why: `${budget} messages already today, and this is not worse` };
      }
      return { send: true, why: "over the day's budget, but this escalated" };
    }
    return {
      send: true,
      why: input.lastSignature === null ? "first breach seen" : "the situation changed",
    };
  }

  // Same situation as last time. Repeat only after the quiet window.
  if (input.lastNotifiedAt === null) return { send: true, why: "never notified" };
  const elapsedHours = (input.now - Date.parse(input.lastNotifiedAt)) / 3_600_000;
  if (elapsedHours >= input.repeatAfterHours) {
    return { send: true, why: `unchanged for ${Math.floor(elapsedHours)}h` };
  }
  return {
    send: false,
    why: `already sent ${elapsedHours.toFixed(1)}h ago, repeats after ${input.repeatAfterHours}h`,
  };
}
