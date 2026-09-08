import { describe, expect, it } from "vitest";

import { resolveCapabilities } from "../src/adapters/mcp";

/**
 * Which Binance tool this app decides to call, pinned to the names Binance
 * actually publishes.
 *
 * Both of these were wrong in production and neither was visible until a real
 * account had money in it. `/balance/i` matched `futures_coin.futuresAccountBalance`,
 * because it sorts ahead of anything spot — so the app asked an empty futures
 * wallet what the portfolio held, was told nothing, and reported the funded
 * sub-account as empty. `/(spot|market).*order/i` matched `spot.deleteOpenOrders`,
 * so the panel advertised an order-placing capability on the strength of a tool
 * that cancels them.
 *
 * The names below are the live list captured on 2026-09-08 with a read + spot
 * scope, trimmed to the families that matter. Discovery stays dynamic — nothing
 * is hardcoded at runtime — but the *resolution* is a decision, and a decision
 * that picked a futures wallet once should have to keep proving it does not.
 */
const LIVE = [
  "tool_search",
  "tool_execute",
  "analysis.getTokenAiReport",
  "convert.acceptQuote",
  "convert.orderStatus",
  "convert.sendQuoteRequest",
  "futures_coin.accountInformation",
  "futures_coin.futuresAccountBalance",
  "futures_coin.newOrder",
  "futures_coin.positionInformation",
  "futures_usds.accountInformationV3",
  "futures_usds.futuresAccountBalanceV3",
  "futures_usds.newOrder",
  "margin.marginAccountNewOrder",
  "margin.queryCrossMarginAccountDetails",
  "spot.deleteOpenOrders",
  "spot.deleteOrder",
  "spot.depth",
  "spot.exchangeInfo",
  "spot.getAccount",
  "spot.getOpenOrders",
  "spot.getOrder",
  "spot.klines",
  "spot.myTrades",
  "spot.newOrder",
  "spot.ticker24hr",
  "spot.tickerPrice",
  "sub_account.getMainAccountAsset",
  "wallet.accountStatus",
  "wallet.queryUserWalletBalance",
  "wallet.withdrawHistory",
].map((name) => ({ name }));

describe("which Binance tool the app decides to call", () => {
  const caps = resolveCapabilities(LIVE);

  it("reads the spot account, not a futures wallet", () => {
    expect(caps.balances).toBe("spot.getAccount");
  });

  it("places orders with the tool that places them", () => {
    expect(caps.placeOrder).toBe("spot.newOrder");
  });

  it("checks an order with the tool that reads one", () => {
    expect(caps.orderStatus).toBe("spot.getOrder");
  });

  it("never resolves anything to a futures or margin tool", () => {
    // This product trades spot. Reading a futures balance is not a near miss;
    // it is a different account, and it reported zero while money sat in spot.
    for (const [capability, tool] of Object.entries(caps)) {
      if (!tool) continue;
      expect(`${capability}: ${tool}`).not.toMatch(/futures|margin/i);
    }
  });

  it("never resolves an order capability to a cancel or a lookup", () => {
    expect(caps.placeOrder).not.toMatch(/delete|cancel|open|all|history/i);
  });

  it("still finds a spot account when the exact name changes", () => {
    // Discovery is dynamic on purpose: Binance publishes no tool list, so a
    // rename must degrade to a near match rather than to null.
    const renamed = [{ name: "spot.accountInformation" }, { name: "futures_coin.futuresAccountBalance" }];
    expect(resolveCapabilities(renamed).balances).toBe("spot.accountInformation");
  });

  it("returns null rather than guessing when nothing fits", () => {
    const caps = resolveCapabilities([{ name: "analysis.getTokenAiReport" }, { name: "tool_search" }]);
    expect(caps.balances).toBeNull();
    expect(caps.placeOrder).toBeNull();
  });

  it("does not mistake a withdrawal history read for a balance", () => {
    const caps = resolveCapabilities([{ name: "wallet.withdrawHistory" }, { name: "spot.getAccount" }]);
    expect(caps.balances).toBe("spot.getAccount");
  });
});
