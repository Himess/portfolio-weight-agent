/**
 * ReplayAdapter — DESIGN.md §8.
 *
 * "The demo depends on market conditions you cannot schedule. Do not gamble on
 * the live market producing a good moment during recording."
 *
 * Replays a captured window of historical klines. The agent loop runs exactly
 * as it does live — same core, same LLM calls — but time is a cursor we control.
 * This is demo insurance and a debugging tool at once: it also lets us *find* a
 * window where HOLD is the right call rather than hoping for one.
 *
 * Order book depth is not available historically, so it is modelled
 * synthetically (see slippage.ts). Slippage figures in replay are therefore
 * estimates of an estimate — the UI labels them as such.
 */

import { syntheticBook } from "../core/slippage";
import type { ExchangeInfo, Holding, Kline, OrderBook } from "../types";
import type { AccountAdapter, MarketAdapter } from "./types";

export type ReplayDataset = {
  symbols: string[];
  interval: string;
  quoteAsset: string;
  /** Aligned by index across symbols; oldest first */
  klines: Record<string, Kline[]>;
  exchangeInfo: ExchangeInfo;
  capturedAt: string;
  /** Optional human label, e.g. "ETH rally, Mar 2026" */
  label?: string;
};

export class ReplayAdapter implements MarketAdapter {
  private cursor = 0;

  constructor(
    private readonly data: ReplayDataset,
    private readonly opts: { spreadBps?: number; depthUsdPerLevel?: number } = {},
  ) {}

  get length(): number {
    return Math.min(...this.data.symbols.map((s) => this.data.klines[s]?.length ?? 0));
  }

  get index(): number {
    return this.cursor;
  }

  /** Timestamp of the current bar, as an ISO string. */
  get asOf(): string {
    const first = this.data.symbols.find((s) => this.data.klines[s]?.length);
    const k = first ? this.data.klines[first][this.cursor] : undefined;
    return new Date(k?.closeTime ?? Date.now()).toISOString();
  }

  seek(index: number): void {
    this.cursor = Math.max(0, Math.min(index, this.length - 1));
  }

  step(by = 1): boolean {
    if (this.cursor + by > this.length - 1) return false;
    this.cursor += by;
    return true;
  }

  async getPrices(symbols: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = { [this.data.quoteAsset]: 1 };
    for (const s of symbols) {
      if (s === this.data.quoteAsset) continue;
      const series = this.data.klines[s];
      if (series?.length) out[s] = series[Math.min(this.cursor, series.length - 1)].close;
    }
    return out;
  }

  async getKlines(symbol: string, _interval: string, limit: number): Promise<Kline[]> {
    const series = this.data.klines[symbol] ?? [];
    // Only history up to and including the cursor — never look ahead.
    const end = Math.min(this.cursor + 1, series.length);
    return series.slice(Math.max(0, end - limit), end);
  }

  async getOrderBook(symbol: string, _depth: number): Promise<OrderBook> {
    const prices = await this.getPrices([symbol]);
    const price = prices[symbol] ?? 0;
    return syntheticBook(`${symbol}${this.data.quoteAsset}`, price, this.opts);
  }

  async getExchangeInfo(): Promise<ExchangeInfo> {
    return this.data.exchangeInfo;
  }
}

/**
 * A paper account that starts from a holdings snapshot and applies fills.
 * Used by the replay harness so a rebalance actually changes the portfolio and
 * the next step sees the consequences.
 */
export class PaperAccount implements AccountAdapter {
  private quantities: Record<string, number>;

  constructor(
    initial: Record<string, number>,
    private readonly market: MarketAdapter,
    private readonly cashSymbol = "USDT",
  ) {
    this.quantities = { ...initial };
  }

  get holdings(): Record<string, number> {
    return { ...this.quantities };
  }

  async getBalances(): Promise<Holding[]> {
    const symbols = Object.keys(this.quantities);
    const prices = await this.market.getPrices(symbols);
    return symbols
      .filter((s) => (this.quantities[s] ?? 0) > 0)
      .map((symbol) => {
        const qty = this.quantities[symbol];
        const priceUsd = symbol === this.cashSymbol ? 1 : (prices[symbol] ?? 0);
        return { symbol, qty, priceUsd, valueUsd: qty * priceUsd };
      });
  }

  /** Apply a fill. Costs are deducted from cash so NAV reflects them. */
  applyFill(args: {
    symbol: string;
    side: "BUY" | "SELL";
    qty: number;
    execPrice: number;
    feeUsd: number;
  }): void {
    const { symbol, side, qty, execPrice, feeUsd } = args;
    const notional = qty * execPrice;
    const signedQty = side === "BUY" ? qty : -qty;
    const signedCash = side === "BUY" ? -notional : notional;

    this.quantities[symbol] = (this.quantities[symbol] ?? 0) + signedQty;
    this.quantities[this.cashSymbol] =
      (this.quantities[this.cashSymbol] ?? 0) + signedCash - feeUsd;

    if (Math.abs(this.quantities[symbol]) < 1e-12) delete this.quantities[symbol];
  }
}
