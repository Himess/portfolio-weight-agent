/**
 * Local persistence for the things a user would be annoyed to retype.
 *
 * An allocation takes real thought to build — weights, a resolved basket, a
 * tracking preference. Losing it to a refresh is the difference between a demo
 * and something someone would actually open twice.
 *
 * Deliberately local-only: no account, no server-side profile, nothing leaves
 * the browser. The allocation is the user's stated intent, not their money, and
 * this app has no login to attach it to.
 *
 * Every read is defensive. Stored state is untrusted input — it may be from an
 * older version of the app, hand-edited, or truncated — so it is validated
 * against the same rules as fresh input and discarded if it does not hold up.
 */

import { validateAllocation } from "../core/allocation";
import type { Allocation, Preference } from "../types";

const KEY = "pwa.allocation.v1";
const VERSION = 1;

type Stored = {
  version: number;
  savedAt: string;
  allocation: Allocation;
  preference: Preference;
};

const PREFERENCES: Preference[] = ["patient", "balanced", "tight", "continuous"];

export function save(allocation: Allocation, preference: Preference): void {
  if (typeof window === "undefined") return;
  try {
    const payload: Stored = {
      version: VERSION,
      savedAt: new Date().toISOString(),
      allocation,
      preference,
    };
    window.localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Private mode, disabled storage, quota — none of which should break the app.
  }
}

export type Restored = { allocation: Allocation; preference: Preference; savedAt: string };

export function load(): Restored | null {
  if (typeof window === "undefined") return null;

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (parsed.version !== VERSION) return null;

    const allocation = parsed.allocation;
    if (!allocation || !Array.isArray(allocation.targets) || typeof allocation.cashSymbol !== "string") {
      return null;
    }

    // The same validator the UI uses. A stored allocation that would be
    // rejected on entry is rejected on restore — no silently-broken state.
    if (!validateAllocation(allocation).ok) return null;

    const preference = PREFERENCES.includes(parsed.preference as Preference)
      ? (parsed.preference as Preference)
      : "balanced";

    return {
      allocation,
      preference,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function clear(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}
