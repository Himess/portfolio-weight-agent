/**
 * Decision history.
 *
 * Two reasons this exists, one of them a bug fix.
 *
 * The bug: the timing decision weighs `daysSinceLastRebalance`, and "staleness"
 * is one of the five factors it can cite. In replay that number comes from the
 * bar index, but in live use there was nothing to compute it from, so `null`
 * was sent every time — meaning the staleness factor could never honestly fire
 * for a real user. It now comes from the last rebalance actually approved.
 *
 * The product reason: an agent that cannot remember its own decisions is a
 * calculator with prose. Recording what it proposed, what you approved and what
 * it declined is what lets it say "you have not rebalanced in three months" and
 * mean it.
 *
 * Local to the browser, like the allocation. Nothing here is money — it is a
 * log of advice given and taken.
 */

import type { TimingAction } from "../types";

const KEY = "pwa.history.v1";
const VERSION = 1;
const MAX_ENTRIES = 200;

export type HistoryEntry = {
  at: string;
  action: TimingAction;
  primaryFactor: string;
  /** Total drift at the moment of the decision */
  driftPp: number;
  navUsd: number;
  /** Trades in the proposal (0 for HOLD) */
  proposed: number;
  /** Whether the user approved and handed them to Binance */
  approved: boolean;
  /** True when the judgment layer was unavailable and the band rule was used */
  fellBack: boolean;
  reasoning: string;
};

type Stored = { version: number; entries: HistoryEntry[] };

function read(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (parsed.version !== VERSION || !Array.isArray(parsed.entries)) return [];
    // Stored state is untrusted: keep only entries that still parse cleanly.
    return parsed.entries.filter(
      (e): e is HistoryEntry =>
        e != null &&
        typeof e.at === "string" &&
        typeof e.action === "string" &&
        Number.isFinite(e.driftPp),
    );
  } catch {
    return [];
  }
}

function write(entries: HistoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    const payload: Stored = { version: VERSION, entries: entries.slice(-MAX_ENTRIES) };
    window.localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable — history is a convenience, never a dependency */
  }
}

export function all(): HistoryEntry[] {
  return read();
}

export function record(entry: Omit<HistoryEntry, "at">): HistoryEntry {
  const full: HistoryEntry = { ...entry, at: new Date().toISOString() };
  write([...read(), full]);
  return full;
}

/** Mark the most recent entry as approved, once the user hands it to Binance. */
export function markApproved(at: string): void {
  const entries = read();
  const i = entries.findIndex((e) => e.at === at);
  if (i < 0) return;
  entries[i] = { ...entries[i], approved: true };
  write(entries);
}

/**
 * Whole days since the last *approved* rebalance.
 *
 * A proposal the user dismissed did not rebalance anything, so it does not
 * reset the clock — otherwise the agent would think the portfolio was fresh
 * because it offered, which is precisely the wrong inference.
 *
 * Returns null when nothing has ever been approved, which the prompt reads as
 * "never" rather than "zero days ago".
 */
export function daysSinceLastRebalance(now = Date.now()): number | null {
  const approved = read().filter((e) => e.approved && e.action !== "HOLD");
  const last = approved[approved.length - 1];
  if (!last) return null;
  const ms = now - new Date(last.at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86_400_000);
}

export function clear(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

export function summary(): { total: number; holds: number; approved: number } {
  const entries = read();
  return {
    total: entries.length,
    holds: entries.filter((e) => e.action === "HOLD").length,
    approved: entries.filter((e) => e.approved).length,
  };
}
