import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The staleness clock. This exists because the timing prompt weighs
 * `daysSinceLastRebalance`, and in live use it was always null — so the
 * "staleness" factor could never honestly fire for a real user.
 */

// jsdom is not configured for this project; a minimal localStorage is enough.
const store = new Map<string, string>();
vi.stubGlobal("window", {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

const { all, clear, daysSinceLastRebalance, markApproved, record, summary } = await import(
  "../src/lib/history"
);

const DAY = 86_400_000;

describe("decision history", () => {
  beforeEach(() => {
    store.clear();
  });

  const entry = (over: Partial<Parameters<typeof record>[0]> = {}) =>
    record({
      action: "REBALANCE",
      primaryFactor: "drift_magnitude",
      driftPp: 8,
      navUsd: 100_000,
      proposed: 2,
      approved: false,
      fellBack: false,
      reasoning: "test",
      ...over,
    });

  it("reports never when nothing has been approved", () => {
    expect(daysSinceLastRebalance()).toBeNull();
    entry(); // proposed but not approved
    expect(daysSinceLastRebalance()).toBeNull();
  });

  it("counts days only from an approved rebalance", () => {
    const e = entry();
    markApproved(e.at);
    const tenDaysOn = new Date(e.at).getTime() + 10 * DAY;
    expect(daysSinceLastRebalance(tenDaysOn)).toBe(10);
  });

  it("does not let a dismissed proposal reset the clock", () => {
    // The wrong inference would be "we just looked, so the portfolio is fresh".
    const approved = entry();
    markApproved(approved.at);
    const base = new Date(approved.at).getTime();

    entry({ driftPp: 9 }); // later proposal, dismissed
    expect(daysSinceLastRebalance(base + 30 * DAY)).toBe(30);
  });

  it("does not let a HOLD reset the clock even if marked approved", () => {
    const approved = entry();
    markApproved(approved.at);
    const base = new Date(approved.at).getTime();

    const held = entry({ action: "HOLD", proposed: 0 });
    markApproved(held.at);
    expect(daysSinceLastRebalance(base + 20 * DAY)).toBe(20);
  });

  it("survives corrupted storage rather than throwing", () => {
    store.set("pwa.history.v1", "{not json");
    expect(all()).toEqual([]);
    expect(daysSinceLastRebalance()).toBeNull();
  });

  it("discards a payload from a different version", () => {
    store.set("pwa.history.v1", JSON.stringify({ version: 99, entries: [{ at: "x" }] }));
    expect(all()).toEqual([]);
  });

  it("summarises reviews, holds and approvals", () => {
    const a = entry();
    markApproved(a.at);
    entry({ action: "HOLD", proposed: 0 });
    entry();
    expect(summary()).toEqual({ total: 3, holds: 1, approved: 1 });
  });

  it("clears", () => {
    entry();
    clear();
    expect(all()).toEqual([]);
  });
});
