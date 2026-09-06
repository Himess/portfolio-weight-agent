/**
 * Category chips for the token picker.
 *
 * This is an editorial taxonomy, not market data. Binance's API does not
 * classify assets, so the mapping is curated and deliberately partial — it
 * exists to make the picker browsable, not to be authoritative.
 *
 * Two rules follow from that:
 *  - "All" is the real, complete list from the exchange, ordered by real 24h
 *    volume. The chips only ever filter it down; they never add anything.
 *  - A symbol absent from this map still appears under "All". Nothing is
 *    hidden because we failed to label it.
 *
 * Prices, changes and volumes never come from here — those are live.
 */

export type CategoryKey = "all" | "l1" | "l2" | "defi" | "ai" | "stake" | "meme" | "cash";

export const CATEGORIES: { key: CategoryKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "l1", label: "Layer 1" },
  { key: "l2", label: "Layer 2" },
  { key: "defi", label: "DeFi" },
  { key: "ai", label: "AI" },
  { key: "stake", label: "Staking" },
  { key: "meme", label: "Memes" },
  { key: "cash", label: "Stablecoins" },
];

const MAP: Record<string, CategoryKey[]> = {
  // Layer 1
  BTC: ["l1"], ETH: ["l1"], BNB: ["l1"], SOL: ["l1"], AVAX: ["l1"], ADA: ["l1"],
  DOT: ["l1"], NEAR: ["l1"], APT: ["l1"], SUI: ["l1"], SEI: ["l1"], TIA: ["l1"],
  ATOM: ["l1"], ALGO: ["l1"], TRX: ["l1"], TON: ["l1"], ICP: ["l1"], HBAR: ["l1"],
  XRP: ["l1"], LTC: ["l1"], BCH: ["l1"], ETC: ["l1"], FIL: ["l1"], KAS: ["l1"],
  INJ: ["l1", "defi"], XLM: ["l1"], VET: ["l1"], EGLD: ["l1"], FLOW: ["l1"],
  ZEC: ["l1"], DASH: ["l1"], XMR: ["l1"], IOTA: ["l1"], MINA: ["l1"], KAVA: ["l1", "defi"],

  // Layer 2 / scaling
  ARB: ["l2"], OP: ["l2"], MATIC: ["l2"], POL: ["l2"], STRK: ["l2"], ZK: ["l2"],
  MANTA: ["l2"], METIS: ["l2"], IMX: ["l2"], LRC: ["l2"], SKL: ["l2"], BLAST: ["l2"],

  // DeFi
  UNI: ["defi"], AAVE: ["defi"], LINK: ["defi"], MKR: ["defi"], CRV: ["defi"],
  LDO: ["defi", "stake"], SNX: ["defi"], COMP: ["defi"], SUSHI: ["defi"], CAKE: ["defi"],
  DYDX: ["defi"], GMX: ["defi"], PENDLE: ["defi"], ENA: ["defi"], MORPHO: ["defi"],
  JUP: ["defi"], RAY: ["defi"], ONDO: ["defi"], ETHFI: ["defi", "stake"],

  // AI
  FET: ["ai"], RENDER: ["ai"], TAO: ["ai"], AGIX: ["ai"], OCEAN: ["ai"], ARKM: ["ai"],
  WLD: ["ai"], NMR: ["ai"], GRT: ["ai"], AI: ["ai"], PHA: ["ai"],

  // Liquid staking / restaking
  RPL: ["stake"], EIGEN: ["stake"], JTO: ["stake"], SSV: ["stake"], ANKR: ["stake"],

  // Memes
  DOGE: ["meme"], SHIB: ["meme"], PEPE: ["meme"], WIF: ["meme"], BONK: ["meme"],
  FLOKI: ["meme"], MEME: ["meme"], BOME: ["meme"], NEIRO: ["meme"], TURBO: ["meme"],

  // Stablecoins
  USDC: ["cash"], FDUSD: ["cash"], TUSD: ["cash"], DAI: ["cash"], USDP: ["cash"],
  USD1: ["cash"], EURI: ["cash"], AEUR: ["cash"],
};

export function categoriesFor(symbol: string): CategoryKey[] {
  return MAP[symbol] ?? [];
}

export function inCategory(symbol: string, key: CategoryKey): boolean {
  return key === "all" || categoriesFor(symbol).includes(key);
}

/** How many of the listed symbols we can actually label — surfaced honestly in the UI. */
export function labelledCount(symbols: string[]): number {
  return symbols.filter((s) => categoriesFor(s).length > 0).length;
}

/**
 * Display names. Binance's public API returns tickers, not names, so this is a
 * small curated list for the assets people actually recognise. Anything absent
 * simply shows its ticker — never a guessed name.
 */
const NAMES: Record<string, string> = {
  BTC: "Bitcoin", ETH: "Ethereum", BNB: "BNB", SOL: "Solana", XRP: "XRP",
  ADA: "Cardano", AVAX: "Avalanche", DOT: "Polkadot", LINK: "Chainlink",
  MATIC: "Polygon", POL: "Polygon", TRX: "TRON", TON: "Toncoin", NEAR: "NEAR",
  APT: "Aptos", SUI: "Sui", ATOM: "Cosmos", LTC: "Litecoin", BCH: "Bitcoin Cash",
  ETC: "Ethereum Classic", FIL: "Filecoin", ICP: "Internet Computer",
  HBAR: "Hedera", XLM: "Stellar", VET: "VeChain", ALGO: "Algorand",
  ARB: "Arbitrum", OP: "Optimism", STRK: "Starknet", IMX: "Immutable",
  UNI: "Uniswap", AAVE: "Aave", MKR: "Maker", CRV: "Curve", LDO: "Lido",
  SNX: "Synthetix", COMP: "Compound", CAKE: "PancakeSwap", DYDX: "dYdX",
  PENDLE: "Pendle", ENA: "Ethena", JUP: "Jupiter", ONDO: "Ondo", INJ: "Injective",
  TIA: "Celestia", SEI: "Sei", KAS: "Kaspa", ZEC: "Zcash", XMR: "Monero",
  FET: "Artificial Superintelligence", RENDER: "Render", TAO: "Bittensor",
  GRT: "The Graph", WLD: "Worldcoin", ARKM: "Arkham", EIGEN: "EigenLayer",
  DOGE: "Dogecoin", SHIB: "Shiba Inu", PEPE: "Pepe", WIF: "dogwifhat",
  BONK: "Bonk", FLOKI: "Floki",
  USDC: "USD Coin", FDUSD: "First Digital USD", TUSD: "TrueUSD", DAI: "Dai",
  USD1: "World Liberty USD",
};

export function displayName(symbol: string): string | null {
  return NAMES[symbol] ?? null;
}
