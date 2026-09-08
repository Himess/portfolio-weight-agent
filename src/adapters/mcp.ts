/**
 * McpAdapter — DESIGN.md §9.2.
 *
 * Binance does not publish the MCP tool list, so nothing here hardcodes a tool
 * name. The adapter is constructed from a discovered tool list (see
 * `npm run mcp:discover` -> docs/mcp-tools.json) and resolves each capability
 * by matching against what the server actually advertises.
 *
 * If a capability cannot be resolved, that capability degrades and says so —
 * the read/analysis path keeps working on public market data, and the app shows
 * the plan without being able to place the order (§9.2 step 3).
 */

import type { ExchangeInfo, Holding, OrderResult, OrderedTrade } from "../types";
import type { AccountAdapter, AdapterStatus, TradeAdapter } from "./types";

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

/**
 * Capability patterns, ordered most- to least-specific, plus what must never
 * match. These are guesses about naming, never assumptions that a tool exists.
 *
 * The rejects are not decoration. Both of the original patterns resolved to the
 * wrong tool against Binance's real list, and neither failure was visible until
 * an account had money in it:
 *
 *   - `/balance/i` matched `futures_coin.futuresAccountBalance` first, because
 *     it sorts ahead of anything spot. The app asked an empty futures wallet
 *     what it held, was told nothing, and reported the sub-account as unfunded
 *     while `spot.getAccount` sat in the same list holding the money.
 *   - `/(spot|market).*order/i` matched `spot.deleteOpenOrders`. The panel
 *     reported "can send orders" on the strength of a tool that cancels them.
 *
 * So: prefer the exact spot tool, then spot-shaped names, and refuse the
 * families this product does not trade in. A spot rebalancer reading a futures
 * balance is not a near miss, it is a different account.
 */
type CapabilitySpec = { prefer: RegExp[]; reject?: RegExp };

const CAPABILITY_PATTERNS: Record<string, CapabilitySpec> = {
  balances: {
    prefer: [
      /^spot\.getAccount$/i,
      /^spot\..*account/i,
      /^wallet\..*balance/i,
      /balance/i,
      /account.*(asset|holding|position)/i,
    ],
    reject: /futures|margin|coin_?m|earn|funding/i,
  },
  placeOrder: {
    prefer: [/^spot\.newOrder$/i, /^spot\..*(new|place|create).*order/i, /(new|place|create).*order/i],
    // Every cancel and lookup tool also contains "order".
    reject: /futures|margin|delete|cancel|query|get|open|all|history|test/i,
  },
  orderStatus: {
    prefer: [/^spot\.getOrder$/i, /^spot\..*(query|get)Order$/i, /order.*(status|query)/i],
    reject: /futures|margin|delete|cancel|new|place|create/i,
  },
};

export type ResolvedCapabilities = {
  balances: string | null;
  placeOrder: string | null;
  orderStatus: string | null;
};

export function resolveCapabilities(tools: McpTool[]): ResolvedCapabilities {
  const names = tools.map((t) => t.name);
  const pick = (key: keyof typeof CAPABILITY_PATTERNS): string | null => {
    const { prefer, reject } = CAPABILITY_PATTERNS[key];
    const eligible = reject ? names.filter((n) => !reject.test(n)) : names;
    for (const re of prefer) {
      const hit = eligible.find((n) => re.test(n));
      if (hit) return hit;
    }
    return null;
  };
  return {
    balances: pick("balances"),
    placeOrder: pick("placeOrder"),
    orderStatus: pick("orderStatus"),
  };
}

export type McpTransport = {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
};

/** Minimal JSON-RPC transport over the streamable-HTTP MCP endpoint. */
export class HttpMcpTransport implements McpTransport {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
  ) {}

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    });

    const text = await res.text();
    const line = text.startsWith("event:") || text.startsWith("data:")
      ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
      : text;

    if (!res.ok) throw new Error(`MCP ${tool} -> HTTP ${res.status}: ${line ?? text}`);
    const parsed = JSON.parse(line ?? text) as { error?: { message: string }; result?: unknown };
    if (parsed.error) throw new Error(`MCP ${tool} -> ${parsed.error.message}`);
    return parsed.result;
  }
}

export class McpAccountAdapter implements AccountAdapter {
  constructor(
    private readonly transport: McpTransport,
    private readonly caps: ResolvedCapabilities,
    private readonly cashSymbol = "USDT",
  ) {}

  async getBalances(): Promise<Holding[]> {
    if (!this.caps.balances) {
      throw new Error(
        "No balance tool was discovered on the MCP server. Run `npm run mcp:discover` with a token, " +
          "or use the public/replay data source.",
      );
    }
    const result = await this.transport.call(this.caps.balances, {});
    return parseBalances(result, this.cashSymbol);
  }
}

/**
 * Balance payload shapes are not documented either, so parse defensively:
 * find any array of objects carrying an asset-ish key and a quantity-ish key.
 */
export function parseBalances(result: unknown, cashSymbol: string): Holding[] {
  const rows = findBalanceArray(result);
  if (!rows) return [];

  const out: Holding[] = [];
  for (const row of rows) {
    const symbol = str(row, ["asset", "symbol", "coin", "currency"]);
    const free = num(row, ["free", "available", "availableBalance", "qty", "quantity", "amount", "balance"]);
    const locked = num(row, ["locked", "frozen"]) ?? 0;
    if (!symbol) continue;
    const qty = (free ?? 0) + locked;
    if (qty <= 0) continue;
    out.push({ symbol, qty, priceUsd: symbol === cashSymbol ? 1 : 0, valueUsd: 0 });
  }
  return out;
}

function findBalanceArray(node: unknown, depth = 0): Record<string, unknown>[] | null {
  if (depth > 6 || node == null) return null;

  if (Array.isArray(node)) {
    const objs = node.filter((n): n is Record<string, unknown> => typeof n === "object" && n !== null);
    if (objs.length > 0 && objs.some((o) => str(o, ["asset", "symbol", "coin", "currency"]))) {
      return objs;
    }
    for (const child of node) {
      const found = findBalanceArray(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node === "object") {
    // MCP tool results wrap content in {content: [{type:"text", text:"<json>"}]}
    const obj = node as Record<string, unknown>;
    if (typeof obj.text === "string") {
      try {
        return findBalanceArray(JSON.parse(obj.text), depth + 1);
      } catch {
        /* not json */
      }
    }
    for (const v of Object.values(obj)) {
      const found = findBalanceArray(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function str(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  return null;
}

function num(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export class McpTradeAdapter implements TradeAdapter {
  constructor(
    private readonly transport: McpTransport,
    private readonly caps: ResolvedCapabilities,
  ) {}

  /**
   * Sends one order. The MCP server surfaces it to the user for confirmation —
   * that is the platform's design and this product's final step (§9.3). We do
   * not attempt to bypass it, and we send trades one at a time so each gets its
   * own confirmation.
   */
  async placeOrder(t: OrderedTrade): Promise<OrderResult> {
    if (!this.caps.placeOrder) {
      return {
        ok: false,
        error:
          "No order-placement tool was discovered on the MCP server. The plan is shown but cannot be executed from here.",
      };
    }

    try {
      const raw = await this.transport.call(this.caps.placeOrder, {
        symbol: t.pair,
        side: t.side,
        type: t.method === "spot_limit" ? "LIMIT" : "MARKET",
        quantity: t.qty,
        ...(t.method === "spot_limit"
          ? { price: limitPrice(t), timeInForce: "GTC" }
          : {}),
      });
      return { ok: true, raw };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** A passive limit sits inside the touch by the chosen offset. */
export function limitPrice(t: OrderedTrade): number {
  const offset = t.limitPriceOffsetBps / 10_000;
  const px = t.side === "BUY" ? t.midPrice * (1 - offset) : t.midPrice * (1 + offset);
  return Number(px.toFixed(8));
}

export function mcpStatus(caps: ResolvedCapabilities | null): AdapterStatus {
  if (!caps) {
    return {
      kind: "mcp",
      label: "Binance MCP (not connected)",
      canReadMarket: false,
      canReadAccount: false,
      canTrade: false,
      note: "Run `npm run mcp:discover` with a bearer token to connect.",
    };
  }
  return {
    kind: "mcp",
    label: "Binance MCP",
    canReadMarket: true,
    canReadAccount: Boolean(caps.balances),
    canTrade: Boolean(caps.placeOrder),
    note: caps.placeOrder
      ? "Every order is confirmed by you in Binance before it executes."
      : "No order tool discovered — proposals are shown but cannot be sent.",
  };
}

/** An ExchangeInfo that carries no symbols; callers fall back to public data. */
export const EMPTY_EXCHANGE_INFO: ExchangeInfo = { symbols: {} };
