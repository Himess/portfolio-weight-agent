/**
 * Data model — DESIGN.md §4.
 *
 * Invariant enforced throughout: all target weights sum to exactly 1.0
 * (within FP tolerance). See core/allocation.ts.
 */

export type Holding = {
  symbol: string;
  qty: number;
  priceUsd: number;
  valueUsd: number;
};

export type TargetLeaf = {
  kind: "asset";
  symbol: string;
  /** Weight of total NAV, 0..1 */
  weight: number;
};

export type BasketMember = {
  symbol: string;
  /** Intra-basket weight; members sum to 1 */
  weight: number;
  why?: string;
};

export type TargetBasket = {
  kind: "basket";
  /** The user's own words: "L1s", "AI tokens" */
  label: string;
  /** Weight of total NAV, 0..1 */
  weight: number;
  members: BasketMember[];
  /** ISO timestamp. Pinned once approved — see DESIGN.md §7.3. */
  resolvedAt: string;
  rationale: string;
};

export type Target = TargetLeaf | TargetBasket;

export type Allocation = {
  targets: Target[];
  /** Cash leg, e.g. "USDT" */
  cashSymbol: string;
};

export type DriftRow = {
  symbol: string;
  /** 0..1 */
  targetWeight: number;
  /** 0..1 */
  currentWeight: number;
  /** (current - target) * 100, signed, percentage points */
  driftPp: number;
  /** target_value - current_value; > 0 means BUY */
  deltaUsd: number;
  outsideBand: boolean;
  /** The band that was applied, in pp — surfaced so the UI can explain the call */
  bandPp: number;
  targetValueUsd: number;
  currentValueUsd: number;
};

export type PortfolioState = {
  navUsd: number;
  rows: DriftRow[];
  /** Σ|driftPp| / 2 — the share of the portfolio that must change hands */
  totalDriftPp: number;
  /** Wall-clock or replay timestamp this snapshot represents */
  asOf: string;
};

// ---------------------------------------------------------------------------
// Exchange metadata
// ---------------------------------------------------------------------------

export type SymbolFilters = {
  /** Trading pair, e.g. "BTCUSDT" */
  pair: string;
  baseAsset: string;
  quoteAsset: string;
  /** LOT_SIZE stepSize */
  stepSize: number;
  minQty: number;
  /** PRICE_FILTER tickSize */
  tickSize: number;
  /** MIN_NOTIONAL / NOTIONAL minNotional */
  minNotional: number;
  status: string;
};

export type ExchangeInfo = {
  /** Keyed by pair, e.g. "BTCUSDT" */
  symbols: Record<string, SymbolFilters>;
};

export type Kline = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
};

export type OrderBookLevel = { price: number; qty: number };

export type OrderBook = {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
};

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export type Side = "BUY" | "SELL";

export type CandidateTrade = {
  /** Stable id within a plan, e.g. "t3" — the LLM references these */
  id: string;
  side: Side;
  /** Base asset, e.g. "BTC" */
  symbol: string;
  /** Trading pair actually used, e.g. "BTCUSDT" */
  pair: string;
  /** Rounded down to stepSize */
  qty: number;
  estNotionalUsd: number;
  estFeeUsd: number;
  estSlippageUsd: number;
  /** Volume-weighted execution price from the order book walk */
  estExecPrice: number;
  midPrice: number;
  /** Signed bps vs mid; positive = worse for the taker */
  slippageBps: number;
  /** Sells before buys — DESIGN.md §5.4 step 3 */
  sequenceIndex: number;
  /** Set when the order book was too thin to fill the whole size */
  bookExhausted: boolean;
};

export type ExecutionMethod = "spot_market" | "spot_limit" | "convert";

export type OrderedTrade = CandidateTrade & {
  method: ExecutionMethod;
  limitPriceOffsetBps: number;
  why: string;
};

export type OrderResult = {
  ok: boolean;
  orderId?: string;
  filledQty?: number;
  avgPrice?: number;
  raw?: unknown;
  error?: string;
};

// ---------------------------------------------------------------------------
// Cost/benefit — DESIGN.md §6
// ---------------------------------------------------------------------------

export type AssetSignals = {
  symbol: string;
  /** stdev of hourly log returns over 24h, expressed in % per hour */
  realizedVol24h: number;
  /** same units, 4h window */
  realizedVol4h: number;
  /** realizedVol4h / realizedVol24h — "is this move still happening" */
  volRatio: number;
  priceChange4hPct: number;
  priceChange24hPct: number;
};

export type CostBenefit = {
  estimatedCostUsd: number;
  totalDriftBeforePp: number;
  totalDriftAfterPp: number;
  driftReductionPp: number;
  /** estimatedCostUsd / max(driftReductionPp, 0.01) */
  costPerPpUsd: number;
  /** estimatedCostUsd as a share of NAV, in bps */
  costBps: number;
};

export type RebalanceContext = {
  asOf: string;
  portfolio: PortfolioState;
  candidates: CandidateTrade[];
  costBenefit: CostBenefit;
  signals: AssetSignals[];
  daysSinceLastRebalance: number | null;
  preference: Preference;
  cashSymbol: string;
};

export type Preference = "patient" | "balanced" | "tight";

export type BandConfig = {
  absoluteFloorPp: number;
  relativeBandPct: number;
};

export type PlanConfig = {
  bands: BandConfig;
  minTradeUsd: number;
  /** Taker fee rate, e.g. 0.001 for 10 bps */
  feeRate: number;
};

// ---------------------------------------------------------------------------
// LLM decisions — DESIGN.md §7
// ---------------------------------------------------------------------------

export type TimingAction = "REBALANCE" | "PARTIAL" | "HOLD";

export type PrimaryFactor =
  | "cost"
  | "volatility"
  | "falling_knife"
  | "drift_magnitude"
  | "staleness";

export type TimingDecision = {
  action: TimingAction;
  assetsToActOn: string[];
  reasoning: string;
  primaryFactor: PrimaryFactor;
  /** True when the model's response failed validation and we used the default */
  fellBack?: boolean;
  fallbackReason?: string;
};

export type ExecutionDecision = {
  orderedTrades: {
    candidateId: string;
    method: ExecutionMethod;
    limitPriceOffsetBps: number;
    why: string;
  }[];
  droppedCandidates: { candidateId: string; why: string }[];
  fellBack?: boolean;
  fallbackReason?: string;
};

export type BasketResolution = {
  members: BasketMember[];
  excluded: { symbol: string; why: string }[];
  rationale: string;
  confidence: "high" | "medium" | "low";
  fellBack?: boolean;
  fallbackReason?: string;
};

export type Proposal = {
  context: RebalanceContext;
  timing: TimingDecision;
  execution: ExecutionDecision | null;
  orderedTrades: OrderedTrade[];
  narrative: string;
};
