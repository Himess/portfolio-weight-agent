/**
 * Starting allocations.
 *
 * A blank page is the worst first screen for this product: deciding target
 * weights is the hard part, and someone who has not done it before has nothing
 * to react to. These give them something to edit.
 *
 * They are starting points, not recommendations — the app has no idea who is
 * looking at it, and saying otherwise would be advice it is not qualified to
 * give. The UI labels them that way.
 *
 * Every symbol here is checked against the live tradable universe before a
 * preset is offered, using the same rule as basket resolution: if Binance does
 * not list it against the cash asset, it does not appear. Nothing is assumed to
 * exist because it existed when this was written.
 */

import type { Target } from "../types";

/**
 * The cash asset. It is never in the tradable universe — there is no
 * USDTUSDT pair — so the availability check has to exempt it explicitly or
 * every preset with a cash leg disappears.
 */
const CASH = "USDT";

export type Preset = {
  key: string;
  name: string;
  blurb: string;
  /** Shown when the preset needs a caveat the weights cannot express */
  caution?: string;
  targets: Target[];
};

const basket = (label: string, weight: number, members: [string, number][], rationale: string): Target => ({
  kind: "basket",
  label,
  weight,
  members: members.map(([symbol, w]) => ({ symbol, weight: w })),
  // Presets are pinned at the moment they are applied, not at authoring time;
  // the UI stamps this when the user picks one.
  resolvedAt: "",
  rationale,
});

const asset = (symbol: string, weight: number): Target => ({ kind: "asset", symbol, weight });

export const PRESETS: Preset[] = [
  {
    key: "majors",
    name: "Majors",
    blurb: "The two largest assets and a cash buffer. The simplest thing that is still a portfolio.",
    targets: [asset("BTC", 0.5), asset("ETH", 0.3), asset("USDT", 0.2)],
  },
  {
    key: "core-satellite",
    name: "Core and satellites",
    blurb: "Majors as the core, a basket of large alternative layer-1s alongside.",
    targets: [
      asset("BTC", 0.4),
      asset("ETH", 0.2),
      basket("L1s", 0.3, [["SOL", 0.5], ["AVAX", 0.5]], "Large-cap alternative layer-1s, equally weighted."),
      asset("USDT", 0.1),
    ],
  },
  {
    key: "cautious",
    name: "Mostly cash",
    blurb: "Majority in stablecoins, a minority position in the two majors.",
    targets: [asset("BTC", 0.2), asset("ETH", 0.1), asset("USDT", 0.7)],
  },
  {
    key: "equities",
    name: "Tokenized US equities",
    blurb: "Index and large-cap exposure through Binance's tokenized stocks, with a cash leg.",
    // These trade far thinner than BTC or ETH — measured single-digit hundreds
    // of thousands of dollars a day against BTC's hundreds of millions. The
    // picker flags each one, but the caveat belongs here too, before the
    // allocation is even applied.
    caution:
      "Tokenized equities trade far thinner than the majors, so rebalancing them moves the price more. The picker marks the thin ones.",
    targets: [
      asset("SPYB", 0.3),
      asset("QQQB", 0.2),
      basket(
        "Mega-cap tech",
        0.3,
        [["NVDAB", 0.34], ["AAPLB", 0.33], ["GOOGLB", 0.33]],
        "Large US technology names, roughly equally weighted.",
      ),
      asset("USDT", 0.2),
    ],
  },
];

/** Every symbol a preset refers to, basket members included. */
export function symbolsOf(preset: Preset): string[] {
  const out: string[] = [];
  for (const t of preset.targets) {
    if (t.kind === "asset") out.push(t.symbol);
    else out.push(...t.members.map((m) => m.symbol));
  }
  return out;
}

/**
 * Presets whose every symbol is currently tradable. A preset referring to a
 * delisted pair is not shown at all rather than applied and then failing at
 * review time with a confusing error.
 */
export function availablePresets(tradable: Set<string>): Preset[] {
  if (tradable.size === 0) return PRESETS; // universe not loaded yet
  return PRESETS.filter((p) =>
    symbolsOf(p).every((s) => s === CASH || tradable.has(s)),
  );
}

/** Stamp the pin time at the moment the user applies it. */
export function applyPreset(preset: Preset): Target[] {
  const now = new Date().toISOString();
  return preset.targets.map((t) =>
    t.kind === "basket" ? { ...t, resolvedAt: now, members: t.members.map((m) => ({ ...m })) } : { ...t },
  );
}
