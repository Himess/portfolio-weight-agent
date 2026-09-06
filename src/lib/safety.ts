/**
 * Per-asset safety signals for the picker.
 *
 * Why this exists, and why it is not a contract-address column:
 *
 * This app trades Binance **spot pairs**, not on-chain tokens. No contract is
 * involved in a spot order, BTC has no ERC-20 address, ETH is native, and most
 * assets are multi-chain. A contract column would be empty or arbitrary for the
 * largest holdings, and worse, it would imply the app trades that on-chain
 * token — the opposite of the reassurance it was meant to give.
 *
 * The real hazards when picking an asset on a CEX are different, and both are
 * measurable from data we already fetch:
 *
 *  1. TICKER CONFUSION. Searching "sol" returns SOL, SOLV and BNSOL — three
 *     different assets whose names contain each other. Picking the wrong one is
 *     the practical version of what people mean by "scam token".
 *  2. THIN LIQUIDITY. A pair that trades $40k a day will move on your own
 *     order. That is a real cost, and it is invisible from the price alone.
 *
 * Everything here is derived from live exchange data. Nothing is a judgement
 * call baked into a list.
 */

export type LiquidityTier = "deep" | "ok" | "thin" | "very-thin";

export type Safety = {
  tier: LiquidityTier;
  /** Higher-volume symbols this one could be mistaken for */
  confusableWith: string[];
  /** True when a much larger symbol contains or is contained by this one */
  isLookalike: boolean;
  notes: string[];
};

/** 24h quote-volume thresholds, in USD. */
export const LIQUIDITY_TIERS = {
  deep: 50_000_000,
  ok: 5_000_000,
  thin: 500_000,
} as const;

export function liquidityTier(quoteVolume24hUsd: number): LiquidityTier {
  if (!Number.isFinite(quoteVolume24hUsd) || quoteVolume24hUsd <= 0) return "very-thin";
  if (quoteVolume24hUsd >= LIQUIDITY_TIERS.deep) return "deep";
  if (quoteVolume24hUsd >= LIQUIDITY_TIERS.ok) return "ok";
  if (quoteVolume24hUsd >= LIQUIDITY_TIERS.thin) return "thin";
  return "very-thin";
}

export function tierLabel(tier: LiquidityTier): string {
  switch (tier) {
    case "deep":
      return "Deep liquidity";
    case "ok":
      return "Adequate liquidity";
    case "thin":
      return "Thin — your order may move the price";
    case "very-thin":
      return "Very thin — expect meaningful slippage";
  }
}

/**
 * How much larger a symbol must be before we call a similar name confusable.
 * A 20x volume gap is a strong signal that one is the household name and the
 * other is riding on it; two comparable assets that merely share letters are
 * not a trap worth warning about.
 */
const DOMINANCE = 20;

/** Minimum symbol length: 2-letter tickers share letters with everything. */
const MIN_LEN = 3;

export type UniverseEntry = { symbol: string; quoteVolume24hUsd: number };

/**
 * Symbols that could be mistaken for a substantially bigger one.
 *
 * The match is deliberately narrow — one symbol containing the other, plus a
 * large volume gap. Fuzzy distance produced too many false positives to be
 * worth showing (ARB/ARK, OP/OM), and a warning nobody trusts is worse than
 * none.
 */
export function findConfusable(symbol: string, universe: UniverseEntry[]): string[] {
  const me = universe.find((u) => u.symbol === symbol);
  if (!me || symbol.length < MIN_LEN) return [];

  return universe
    .filter((other) => {
      if (other.symbol === symbol) return false;
      if (other.symbol.length < MIN_LEN) return false;
      const contains =
        symbol.includes(other.symbol) || other.symbol.includes(symbol);
      if (!contains) return false;
      return other.quoteVolume24hUsd > me.quoteVolume24hUsd * DOMINANCE;
    })
    .sort((a, b) => b.quoteVolume24hUsd - a.quoteVolume24hUsd)
    .slice(0, 3)
    .map((u) => u.symbol);
}

export function assess(
  symbol: string,
  quoteVolume24hUsd: number,
  universe: UniverseEntry[],
): Safety {
  const tier = liquidityTier(quoteVolume24hUsd);
  const confusableWith = findConfusable(symbol, universe);
  const notes: string[] = [];

  if (tier === "thin" || tier === "very-thin") notes.push(tierLabel(tier));
  if (confusableWith.length > 0) {
    notes.push(
      `Similar name to ${confusableWith.join(", ")} — a much larger market. Check you meant this one.`,
    );
  }

  return { tier, confusableWith, isLookalike: confusableWith.length > 0, notes };
}
