/**
 * Adapter interfaces — DESIGN.md §9.1.
 *
 * Everything upstream of these interfaces is pure. Three implementations:
 *   PublicAdapter  — Binance public market data, no auth
 *   ReplayAdapter  — historical klines, for the demo and for debugging
 *   McpAdapter     — live, via the Binance MCP server (OAuth)
 *
 * Build and test against the first two; swap in the third last.
 */

import type {
  ExchangeInfo,
  Holding,
  Kline,
  OrderBook,
  OrderResult,
  OrderedTrade,
} from "../types";

export interface MarketAdapter {
  getPrices(symbols: string[]): Promise<Record<string, number>>;
  getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]>;
  getOrderBook(symbol: string, depth: number): Promise<OrderBook>;
  /**
   * Filters for the given base symbols. Always pass the symbols you need:
   * Binance's unfiltered exchangeInfo is ~17 MB, the filtered form ~15 KB.
   * Implementations that hold a fixed snapshot (replay) may ignore the argument.
   */
  getExchangeInfo(symbols?: string[]): Promise<ExchangeInfo>;
}

export interface AccountAdapter {
  getBalances(): Promise<Holding[]>;
}

export interface TradeAdapter {
  placeOrder(t: OrderedTrade): Promise<OrderResult>;
}

/** What the app knows about the currently selected data source. */
export type AdapterKind = "public" | "replay" | "mcp";

export type AdapterStatus = {
  kind: AdapterKind;
  label: string;
  /** Can we read market data? */
  canReadMarket: boolean;
  /** Can we read real balances? */
  canReadAccount: boolean;
  /** Can we place orders? */
  canTrade: boolean;
  note: string;
};
