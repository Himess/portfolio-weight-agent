import { describe, expect, it } from "vitest";

import { applyEdits, describeApplied, type Edit } from "../src/core/commands";
import { validateAllocation } from "../src/core/allocation";
import type { Target } from "../src/types";

const TRADABLE = new Set(["BTC", "ETH", "SOL", "AVAX", "SUI", "TAO"]);

const base: Target[] = [
  { kind: "asset", symbol: "BTC", weight: 0.4 },
  { kind: "asset", symbol: "ETH", weight: 0.2 },
  { kind: "asset", symbol: "USDT", weight: 0.4 },
];

const opts = { cashSymbol: "USDT", tradable: TRADABLE };

describe("typed instructions", () => {
  it("changes a weight and lets cash absorb the difference", () => {
    const r = applyEdits(base, [{ op: "set", symbol: "BTC", weightPct: 50 }], opts);
    expect(r.totalPct).toBe(100);
    expect(r.applied).toEqual([{ op: "set", symbol: "BTC", fromPct: 40, toPct: 50 }]);
    // 10 points came out of cash, not out of thin air.
    expect(r.cashDeltaPp).toBe(-10);
    expect(validateAllocation({ targets: r.targets, cashSymbol: "USDT" })).toEqual({ ok: true });
  });

  it("adds a leg that was not there", () => {
    const r = applyEdits(base, [{ op: "add", symbol: "SOL", weightPct: 15 }], opts);
    expect(r.applied[0]).toEqual({ op: "add", symbol: "SOL", fromPct: null, toPct: 15 });
    expect(r.totalPct).toBe(100);
    expect(validateAllocation({ targets: r.targets, cashSymbol: "USDT" })).toEqual({ ok: true });
  });

  it("applies several edits from one sentence", () => {
    const edits: Edit[] = [
      { op: "set", symbol: "BTC", weightPct: 30 },
      { op: "add", symbol: "SUI", weightPct: 10 },
      { op: "remove", symbol: "ETH" },
    ];
    const r = applyEdits(base, edits, opts);
    expect(r.applied.map((a) => a.symbol)).toEqual(["BTC", "SUI", "ETH"]);
    expect(r.totalPct).toBe(100);
    expect(r.targets.find((t) => t.kind === "asset" && t.symbol === "ETH")).toBeUndefined();
  });

  it("refuses a symbol that does not trade, and keeps the rest", () => {
    const r = applyEdits(
      base,
      [
        { op: "add", symbol: "HYPE", weightPct: 10 },
        { op: "add", symbol: "SOL", weightPct: 10 },
      ],
      opts,
    );
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].why).toContain("does not trade");
    // The good edit still lands — one bad clause must not lose the sentence.
    expect(r.applied.map((a) => a.symbol)).toEqual(["SOL"]);
  });

  it("is case- and whitespace-insensitive about tickers", () => {
    const r = applyEdits(base, [{ op: "add", symbol: "  sui ", weightPct: 5 }], opts);
    expect(r.applied[0].symbol).toBe("SUI");
  });

  it("refuses weights that are not weights", () => {
    for (const weightPct of [0, -5, 140, Number.NaN]) {
      const r = applyEdits(base, [{ op: "set", symbol: "BTC", weightPct }], opts);
      expect(r.rejected).toHaveLength(1);
      expect(r.applied).toHaveLength(0);
    }
  });

  it("will not remove the cash leg", () => {
    const r = applyEdits(base, [{ op: "remove", symbol: "USDT" }], opts);
    expect(r.rejected[0].why).toContain("cash leg");
    expect(r.targets).toHaveLength(3);
  });

  it("refuses to remove something that is not there", () => {
    const r = applyEdits(base, [{ op: "remove", symbol: "SOL" }], opts);
    expect(r.rejected[0].why).toContain("not in the allocation");
  });

  it("respects an explicit cash instruction instead of overwriting it", () => {
    // "put 30% in cash" must not be silently recomputed away.
    const r = applyEdits(base, [{ op: "set", symbol: "USDT", weightPct: 30 }], opts);
    const cash = r.targets.find((t) => t.kind === "asset" && t.symbol === "USDT")!;
    expect(cash.weight).toBeCloseTo(0.3, 10);
    // ...and the shortfall is left visible rather than papered over.
    expect(r.totalPct).toBe(90);
  });

  it("never drives cash negative — the overflow stays visible", () => {
    const r = applyEdits(base, [{ op: "set", symbol: "BTC", weightPct: 95 }], opts);
    const cash = r.targets.find((t) => t.kind === "asset" && t.symbol === "USDT")!;
    expect(cash.weight).toBe(0);
    expect(r.totalPct).toBe(115);
    // Which validateAllocation then refuses, exactly as a hand-typed 115% would.
    expect(validateAllocation({ targets: r.targets, cashSymbol: "USDT" }).ok).toBe(false);
  });

  it("changes a basket's weight without disturbing its members", () => {
    const withBasket: Target[] = [
      { kind: "asset", symbol: "BTC", weight: 0.4 },
      {
        kind: "basket",
        label: "L1s",
        weight: 0.3,
        members: [
          { symbol: "SOL", weight: 0.5 },
          { symbol: "AVAX", weight: 0.5 },
        ],
        resolvedAt: "2026-01-01T00:00:00.000Z",
        rationale: "x",
      },
      { kind: "asset", symbol: "USDT", weight: 0.3 },
    ];
    const r = applyEdits(withBasket, [{ op: "set", symbol: "l1s", weightPct: 20 }], opts);
    const basket = r.targets.find((t) => t.kind === "basket")!;
    expect(basket.weight).toBeCloseTo(0.2, 10);
    if (basket.kind === "basket") {
      expect(basket.members.map((m) => m.symbol)).toEqual(["SOL", "AVAX"]);
      // Pinning must survive a weight change — a silent re-resolve breaks trust.
      expect(basket.resolvedAt).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  it("does not check symbols when the universe has not loaded", () => {
    // Better to accept and let the review fail loudly than to reject a real
    // ticker because a market-data call was slow.
    const r = applyEdits(base, [{ op: "add", symbol: "SOL", weightPct: 5 }], {
      cashSymbol: "USDT",
      tradable: new Set(),
    });
    expect(r.rejected).toHaveLength(0);
  });

  it("leaves the input untouched", () => {
    const before = JSON.stringify(base);
    applyEdits(base, [{ op: "set", symbol: "BTC", weightPct: 10 }], opts);
    expect(JSON.stringify(base)).toBe(before);
  });

  it("describes each change without model prose", () => {
    const r = applyEdits(
      base,
      [
        { op: "set", symbol: "BTC", weightPct: 50 },
        { op: "add", symbol: "SOL", weightPct: 5 },
        { op: "remove", symbol: "ETH" },
      ],
      opts,
    );
    const lines = r.applied.map((a) => describeApplied(a, "USDT"));
    expect(lines).toEqual(["BTC 40% → 50%", "Added SOL at 5%", "Removed ETH (was 20%)"]);
  });

  it("does not report a weight set to what it already was", () => {
    const r = applyEdits(base, [{ op: "set", symbol: "BTC", weightPct: 40 }], opts);
    expect(r.applied).toHaveLength(0);
    expect(r.rejected).toHaveLength(0);
  });

  it("lets cash reach zero and still validate — that is a real choice", () => {
    // BTC 40 / ETH 20 / USDT 40, then add 40 more of risk: cash goes to 0 and
    // the allocation is fully invested. Rejecting that made "add SUI at 10"
    // fail on a portfolio the owner had deliberately built.
    const r = applyEdits(base, [{ op: "add", symbol: "SOL", weightPct: 40 }], opts);
    const cash = r.targets.find((t) => t.kind === "asset" && t.symbol === "USDT")!;
    expect(cash.weight).toBe(0);
    expect(r.totalPct).toBe(100);
    expect(validateAllocation({ targets: r.targets, cashSymbol: "USDT" })).toEqual({ ok: true });
  });

  it("still refuses a zero-weight risk leg", () => {
    const withZero: Target[] = [
      { kind: "asset", symbol: "BTC", weight: 1 },
      { kind: "asset", symbol: "SOL", weight: 0 },
      { kind: "asset", symbol: "USDT", weight: 0 },
    ];
    const res = validateAllocation({ targets: withZero, cashSymbol: "USDT" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/SOL/);
  });

  it("leaves the allocation untouched when every edit is rejected", () => {
    // Caught in the browser: the router expanded "remove L1s" into its two
    // member symbols, neither of which is a top-level leg, so both were
    // rejected -- and cash was still recomputed as 100 minus the rest, which
    // drove it to zero and left the allocation at 110%. A command that does
    // nothing must change nothing.
    const before = JSON.parse(JSON.stringify(base));
    const r = applyEdits(
      base,
      [
        { op: "remove", symbol: "SOL" },
        { op: "remove", symbol: "AVAX" },
      ],
      opts,
    );
    expect(r.applied).toEqual([]);
    expect(r.rejected).toHaveLength(2);
    expect(r.targets).toEqual(before);
    expect(r.totalPct).toBe(100);
    expect(r.cashDeltaPp).toBe(0);
  });

  it("still lets cash absorb when at least one edit lands", () => {
    const r = applyEdits(
      base,
      [
        { op: "remove", symbol: "NOPE" },
        { op: "set", symbol: "BTC", weightPct: 50 },
      ],
      opts,
    );
    expect(r.applied).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.cashDeltaPp).toBe(-10);
    expect(r.totalPct).toBe(100);
  });
});
