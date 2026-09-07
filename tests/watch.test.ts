import { describe, expect, it } from "vitest";

import { breachedSymbols, sentLast24h, shouldNotify, signatureOf } from "../src/lib/watch";
import { composeMessage, splitNarrative, toPlainText } from "../src/lib/watch-message";
import { BANDS } from "../src/core/bands";
import { computeDrift, buildHoldings } from "../src/core/drift";
import type { Allocation, PortfolioState } from "../src/types";

const ALLOCATION: Allocation = {
  cashSymbol: "USDT",
  targets: [
    { kind: "asset", symbol: "BTC", weight: 0.5 },
    { kind: "asset", symbol: "ETH", weight: 0.3 },
    { kind: "asset", symbol: "USDT", weight: 0.2 },
  ],
};

function stateWith(prices: Record<string, number>): PortfolioState {
  // 0.5 BTC, 12 ETH, 20,000 USDT — priced so the caller decides who has drifted.
  const holdings = buildHoldings({ BTC: 0.5, ETH: 12, USDT: 20_000 }, prices, "USDT");
  return computeDrift(holdings, ALLOCATION, { bands: BANDS.balanced });
}

const base = {
  lastSignature: null,
  lastNotifiedAt: null,
  repeatAfterHours: 24,
  paused: false,
  bound: true,
  now: Date.parse("2026-09-07T12:00:00Z"),
};

describe("shouldNotify", () => {
  it("says nothing when everything is inside its bands and always was", () => {
    const d = shouldNotify({
      ...base,
      signature: { verdict: "IN_BAND", assets: [] },
      lastSignature: signatureOf({ verdict: "IN_BAND", assets: [] }),
    });
    expect(d.send).toBe(false);
  });

  it("does not announce calm on a first scan either", () => {
    // lastSignature is null, so the situation has "changed" in the naive sense.
    // A brand-new watch that is inside its bands must still stay quiet.
    const d = shouldNotify({ ...base, signature: { verdict: "IN_BAND", assets: [] } });
    expect(d.send).toBe(false);
  });

  it("fires on the first breach", () => {
    const d = shouldNotify({ ...base, signature: { verdict: "REBALANCE", assets: ["BTC"] } });
    expect(d.send).toBe(true);
    expect(d.why).toContain("first breach");
  });

  it("stays quiet while the same situation persists inside the repeat window", () => {
    const sig = { verdict: "REBALANCE" as const, assets: ["BTC"] };
    const d = shouldNotify({
      ...base,
      signature: sig,
      lastSignature: signatureOf(sig),
      lastNotifiedAt: new Date(base.now - 3 * 3_600_000).toISOString(),
    });
    expect(d.send).toBe(false);
    expect(d.why).toContain("repeats after 24h");
  });

  it("repeats once the quiet window has passed", () => {
    const sig = { verdict: "REBALANCE" as const, assets: ["BTC"] };
    const d = shouldNotify({
      ...base,
      signature: sig,
      lastSignature: signatureOf(sig),
      lastNotifiedAt: new Date(base.now - 25 * 3_600_000).toISOString(),
    });
    expect(d.send).toBe(true);
  });

  it("speaks up immediately when the verdict changes, window or no window", () => {
    const d = shouldNotify({
      ...base,
      signature: { verdict: "REBALANCE", assets: ["BTC"] },
      lastSignature: signatureOf({ verdict: "HOLD", assets: ["BTC"] }),
      lastNotifiedAt: new Date(base.now - 60_000).toISOString(),
    });
    expect(d.send).toBe(true);
    expect(d.why).toContain("changed");
  });

  it("speaks up when a different asset joins the breach", () => {
    const d = shouldNotify({
      ...base,
      signature: { verdict: "REBALANCE", assets: ["BTC", "ETH"] },
      lastSignature: signatureOf({ verdict: "REBALANCE", assets: ["BTC"] }),
      lastNotifiedAt: new Date(base.now - 60_000).toISOString(),
    });
    expect(d.send).toBe(true);
  });

  it("is order-insensitive about which assets are breached", () => {
    expect(signatureOf({ verdict: "HOLD", assets: ["ETH", "BTC"] })).toBe(
      signatureOf({ verdict: "HOLD", assets: ["BTC", "ETH"] }),
    );
  });

  it("sends exactly one all-clear when it comes back into range", () => {
    const back = shouldNotify({
      ...base,
      signature: { verdict: "IN_BAND", assets: [] },
      lastSignature: signatureOf({ verdict: "REBALANCE", assets: ["BTC"] }),
      lastNotifiedAt: new Date(base.now - 60_000).toISOString(),
    });
    expect(back.send).toBe(true);

    // ...and nothing on the scan after that.
    const after = shouldNotify({
      ...base,
      signature: { verdict: "IN_BAND", assets: [] },
      lastSignature: signatureOf({ verdict: "IN_BAND", assets: [] }),
      lastNotifiedAt: new Date(base.now - 60_000).toISOString(),
    });
    expect(after.send).toBe(false);
  });

  it("says nothing at all while paused or unbound", () => {
    const sig = { verdict: "REBALANCE" as const, assets: ["BTC"] };
    expect(shouldNotify({ ...base, signature: sig, paused: true }).send).toBe(false);
    expect(shouldNotify({ ...base, signature: sig, bound: false }).send).toBe(false);
  });
});

describe("breachedSymbols", () => {
  it("uses the same bands the app draws, and never names cash", () => {
    // BTC at 50% target gets a 12.5pp band. Push it well past that.
    const state = stateWith({ BTC: 400_000, ETH: 2_500, USDT: 1 });
    const breached = breachedSymbols(state, "USDT");
    expect(breached).toContain("BTC");
    expect(breached).not.toContain("USDT");
  });

  it("is empty for a portfolio sitting on its target", () => {
    // 0.5 BTC @ 40k = 20k (50%), 12 ETH @ 1000 = 12k (30%), 20k cash... not
    // quite; solve it exactly instead of eyeballing.
    const nav = 100_000;
    const prices = { BTC: (nav * 0.5) / 0.5, ETH: (nav * 0.3) / 12, USDT: 1 };
    const holdings = buildHoldings({ BTC: 0.5, ETH: 12, USDT: nav * 0.2 }, prices, "USDT");
    const state = computeDrift(holdings, ALLOCATION, { bands: BANDS.balanced });
    expect(state.totalDriftPp).toBeCloseTo(0, 6);
    expect(breachedSymbols(state, "USDT")).toEqual([]);
  });
});

describe("composeMessage", () => {
  const state = stateWith({ BTC: 400_000, ETH: 2_500, USDT: 1 });
  const breached = breachedSymbols(state, "USDT");

  it("leads with the agent's headline and keeps its prose", () => {
    const html = composeMessage({
      label: "BTC / ETH / USDT",
      preference: "balanced",
      state,
      breached,
      verdict: "REBALANCE",
      narrative: "BTC has run far past its band\n\nTrimming it back costs about a tenth of a percent.",
      fellBack: false,
    });
    expect(html).toContain("<b>BTC has run far past its band</b>");
    expect(html).toContain("Trimming it back costs about a tenth of a percent.");
  });

  it("names the band it actually applied, not a generic threshold", () => {
    const html = composeMessage({
      label: null,
      preference: "balanced",
      state,
      breached,
      verdict: "REBALANCE",
      narrative: "h\n\nb",
      fellBack: false,
    });
    const btc = state.rows.find((r) => r.symbol === "BTC")!;
    expect(html).toContain(`band ±${btc.bandPp.toFixed(1)}pp`);
  });

  it("says a HOLD needs no approval, and a rebalance has ordered nothing", () => {
    const hold = composeMessage({
      label: null, preference: "patient", state, breached,
      verdict: "HOLD", narrative: "Waiting\n\nThe move is still running.", fellBack: false,
    });
    expect(hold).toContain("Nothing to approve");

    const rebalance = composeMessage({
      label: null, preference: "patient", state, breached,
      verdict: "REBALANCE", narrative: "Act\n\nNow.", fellBack: false,
    });
    expect(rebalance).toContain("Nothing has been ordered");
  });

  it("admits when the verdict is a deterministic fallback", () => {
    const html = composeMessage({
      label: null, preference: "balanced", state, breached,
      verdict: "REBALANCE", narrative: "h\n\nb", fellBack: true,
    });
    expect(html).toContain("judgment layer was unavailable");
  });

  it("escapes anything interpolated, so a label cannot inject markup", () => {
    const html = composeMessage({
      label: "<b>not mine</b>",
      preference: "balanced",
      state: stateWith({ BTC: 80_000, ETH: 2_500, USDT: 1 }),
      breached: [],
      verdict: "IN_BAND",
      narrative: "",
      fellBack: false,
    });
    expect(html).toContain("&lt;b&gt;not mine&lt;/b&gt;");
    expect(html).not.toContain("<b>not mine</b>");
  });

  it("closes the loop with a plain all-clear", () => {
    const calm = stateWith({ BTC: 80_000, ETH: 2_500, USDT: 1 });
    const text = toPlainText(
      composeMessage({
        label: "Majors",
        preference: "balanced",
        state: calm,
        breached: [],
        verdict: "IN_BAND",
        narrative: "",
        fellBack: false,
      }),
    );
    expect(text).toContain("Back inside its bands");
    expect(text).toContain("Nothing to do");
  });
});

describe("splitNarrative", () => {
  it("separates the headline from the body", () => {
    expect(splitNarrative("Head\n\nBody text")).toEqual({ headline: "Head", body: "Body text" });
  });

  it("survives a narrative with no blank line", () => {
    expect(splitNarrative("Just a headline")).toEqual({ headline: "Just a headline", body: "" });
  });
});

describe("the day's interruption budget", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

  const spent = (n: number) => Array.from({ length: n }, (_, i) => hoursAgo(i + 1));

  const base = {
    lastNotifiedAt: hoursAgo(1),
    repeatAfterHours: 24,
    paused: false,
    bound: true,
    now,
    dailyAskBudget: 2,
  };

  it("counts only the trailing 24 hours", () => {
    expect(sentLast24h([hoursAgo(1), hoursAgo(25), hoursAgo(200)], now)).toBe(1);
    expect(sentLast24h(undefined, now)).toBe(0);
  });

  it("lets a changed situation through while there is budget left", () => {
    const d = shouldNotify({
      ...base,
      sentAt: spent(1),
      signature: { verdict: "REBALANCE", assets: ["BTC"] },
      lastSignature: signatureOf({ verdict: "REBALANCE", assets: ["ETH"] }),
    });
    expect(d.send).toBe(true);
  });

  it("stops interrupting once the budget is spent", () => {
    // Same two assets swapping between HOLD and PARTIAL all afternoon is one
    // bad morning, not four messages.
    const d = shouldNotify({
      ...base,
      sentAt: spent(2),
      signature: { verdict: "PARTIAL", assets: ["BTC"] },
      lastSignature: signatureOf({ verdict: "REBALANCE", assets: ["BTC"] }),
    });
    expect(d.send).toBe(false);
    expect(d.why).toContain("not worse");
  });

  it("still delivers a new asset in trouble", () => {
    const d = shouldNotify({
      ...base,
      sentAt: spent(5),
      signature: { verdict: "REBALANCE", assets: ["BTC", "SOL"] },
      lastSignature: signatureOf({ verdict: "REBALANCE", assets: ["BTC"] }),
    });
    expect(d.send).toBe(true);
    expect(d.why).toContain("escalated");
  });

  it("still delivers the moment waiting turns into acting", () => {
    const d = shouldNotify({
      ...base,
      sentAt: spent(9),
      signature: { verdict: "REBALANCE", assets: ["BTC"] },
      lastSignature: signatureOf({ verdict: "HOLD", assets: ["BTC"] }),
    });
    expect(d.send).toBe(true);
  });

  it("does not treat acting turning into waiting as an escalation", () => {
    const d = shouldNotify({
      ...base,
      sentAt: spent(4),
      signature: { verdict: "HOLD", assets: ["BTC"] },
      lastSignature: signatureOf({ verdict: "REBALANCE", assets: ["BTC"] }),
    });
    expect(d.send).toBe(false);
  });

  it("behaves exactly as before when no budget is supplied", () => {
    const d = shouldNotify({
      ...base,
      dailyAskBudget: undefined,
      sentAt: spent(20),
      signature: { verdict: "PARTIAL", assets: ["BTC"] },
      lastSignature: signatureOf({ verdict: "REBALANCE", assets: ["BTC"] }),
    });
    expect(d.send).toBe(true);
  });

  it("never lets the budget suppress the all-clear", () => {
    const d = shouldNotify({
      ...base,
      sentAt: spent(9),
      signature: { verdict: "IN_BAND", assets: [] },
      lastSignature: signatureOf({ verdict: "REBALANCE", assets: ["BTC"] }),
    });
    expect(d.send).toBe(true);
  });
});
