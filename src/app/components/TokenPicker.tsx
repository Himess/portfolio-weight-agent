"use client";

/**
 * Token picker — search, category chips, and a live list.
 *
 * Structure follows PortfolioAgentUI.jsx. The data does not: that file ships a
 * static token table with baked-in prices and synthesises each sparkline from a
 * hash of the ticker. Everything here is live — price, 24h change and volume
 * from one Binance ticker call, sparklines from real hourly closes fetched for
 * the rows actually on screen.
 *
 * Logos are monograms rather than a CDN image. A remote icon host is one more
 * thing to break mid-demo, and a broken image is worse than a clean initial.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { Skeleton, Sparkline, TokenLogo, TokenRowSkeleton } from "./ui";
import { CATEGORIES, type CategoryKey, displayName, inCategory } from "@/lib/categories";
import { assess, tierLabel } from "@/lib/safety";

export type TokenRow = {
  symbol: string;
  pair: string;
  priceUsd: number;
  change24hPct: number;
  quoteVolume24hUsd: number;
  categories: CategoryKey[];
};

const VISIBLE = 12;

function price(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
}

function volume(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${(n / 1e3).toFixed(0)}K`;
}

export function TokenPicker({
  held,
  onToggle,
  onUniverse,
}: {
  held: Set<string>;
  onToggle: (symbol: string) => void;
  /**
   * Reports every symbol that trades against the cash asset — not just the
   * rows shown below, which are capped by volume. A preset or basket naming a
   * real but low-volume pair must not be treated as delisted.
   */
  onUniverse?: (symbols: Set<string>) => void;
}) {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<CategoryKey>("all");
  const [series, setSeries] = useState<Record<string, number[]>>({});
  const inflight = useRef<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/tokens?limit=250")
      .then((r) => r.json())
      .then((j) => {
        if (j.error) {
          setError(j.error);
          return;
        }
        const rows = j.tokens as TokenRow[];
        // The cash asset can never appear in this list: it is built from pairs
        // quoted in USDT, and there is no USDTUSDT. So removing the cash leg
        // used to be one-way — the picker had no row to add it back with.
        // It is always addable, so it is always here, at the top.
        const CASH = "USDT";
        const withCash = rows.some((t) => t.symbol === CASH)
          ? rows
          : [
              {
                symbol: CASH,
                pair: CASH,
                priceUsd: 1,
                change24hPct: 0,
                quoteVolume24hUsd: Number.POSITIVE_INFINITY,
                categories: ["cash"] as CategoryKey[],
              },
              ...rows,
            ];
        setTokens(withCash);
        onUniverse?.(
          new Set((j.universe as string[] | undefined) ?? rows.map((t) => t.symbol)),
        );
      })
      .catch(() => setError("Could not reach Binance market data."));
  }, [onUniverse]);

  const universe = useMemo(
    () => (tokens ?? []).map((t) => ({ symbol: t.symbol, quoteVolume24hUsd: t.quoteVolume24hUsd })),
    [tokens],
  );

  const list = useMemo(() => {
    if (!tokens) return [];
    const needle = q.trim().toUpperCase();
    return tokens
      .filter((t) => inCategory(t.symbol, cat))
      .filter(
        (t) =>
          !needle ||
          t.symbol.includes(needle) ||
          (displayName(t.symbol) ?? "").toUpperCase().includes(needle),
      )
      .slice(0, 60);
  }, [tokens, q, cat]);

  // Sparklines only for the rows on screen, once each.
  const wanted = useMemo(() => list.slice(0, VISIBLE).map((t) => t.symbol), [list]);

  useEffect(() => {
    const missing = wanted.filter((s) => !(s in series) && !inflight.current.has(s));
    if (missing.length === 0) return;
    missing.forEach((s) => inflight.current.add(s));

    const id = setTimeout(() => {
      fetch(`/api/sparks?symbols=${missing.join(",")}`)
        .then((r) => r.json())
        .then((j) => setSeries((prev) => ({ ...prev, ...(j.series ?? {}) })))
        .catch(() => {
          /* no sparkline is fine */
        })
        .finally(() => missing.forEach((s) => inflight.current.delete(s)));
    }, 180); // debounce typing

    return () => clearTimeout(id);
  }, [wanted, series]);

  return (
    <div className="card card-p">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Add assets</h2>
        {tokens ? (
          <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
            {tokens.filter((t) => t.pair !== t.symbol).length} tradable pairs · live prices
          </span>
        ) : (
          <Skeleton w={150} h={11} />
        )}
      </div>

      <div className="search" style={{ marginTop: 14 }}>
        <span style={{ color: "var(--ink-3)", fontSize: 13 }}>⌕</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search any token on Binance"
          aria-label="Search tokens"
        />
        {q && (
          <button className="btn-link" onClick={() => setQ("")} aria-label="Clear search">
            ✕
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: 7, marginTop: 12, flexWrap: "wrap" }}>
        {CATEGORIES.map((c) => (
          <button key={c.key} className="chip" data-on={cat === c.key ? 1 : 0} onClick={() => setCat(c.key)}>
            {c.label}
          </button>
        ))}
      </div>

      {error && (
        <p style={{ fontSize: 12.5, color: "var(--red)", marginTop: 14 }}>{error}</p>
      )}

      <div className="scroll" style={{ marginTop: 12, maxHeight: 340, marginInline: -6 }}>
        {!tokens && !error && (
          <>
            {Array.from({ length: 6 }, (_, i) => (
              <TokenRowSkeleton key={i} />
            ))}
          </>
        )}

        {tokens && list.length === 0 && (
          <p style={{ fontSize: 12.5, color: "var(--ink-3)", padding: "16px 6px" }}>
            Nothing matches “{q}”{cat !== "all" ? ` in ${CATEGORIES.find((c) => c.key === cat)?.label}` : ""}.
          </p>
        )}

        {list.map((t) => {
          const on = held.has(t.symbol);
          const name = displayName(t.symbol);
          const up = t.change24hPct >= 0;
          const safety = assess(t.symbol, t.quoteVolume24hUsd, universe);
          return (
            <button key={t.symbol} className="tk" data-in={on ? 1 : 0} onClick={() => onToggle(t.symbol)}>
              <TokenLogo symbol={t.symbol} />

              <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>{t.symbol}</span>
                  {safety.isLookalike && (
                    <span
                      className="pill pill-accent"
                      style={{ padding: "1px 7px", fontSize: 9.5, fontWeight: 700 }}
                      title={`Similar name to ${safety.confusableWith.join(", ")}, a much larger market. Check you meant this one.`}
                    >
                      like {safety.confusableWith[0]}
                    </span>
                  )}
                  {(safety.tier === "thin" || safety.tier === "very-thin") && (
                    <span
                      className="pill pill-red"
                      style={{ padding: "1px 7px", fontSize: 9.5, fontWeight: 700 }}
                      title={tierLabel(safety.tier)}
                    >
                      thin
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--ink-3)",
                    marginTop: 1,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {name ?? t.pair} · {volume(t.quoteVolume24hUsd)} 24h
                </div>
              </div>

              <Sparkline closes={series[t.symbol] ?? []} width={54} height={24} />

              <div style={{ textAlign: "right", minWidth: 78 }}>
                <div className="m" style={{ fontSize: 12.5, fontWeight: 600 }}>
                  {price(t.priceUsd)}
                </div>
                <div className="m" style={{ fontSize: 11.5, marginTop: 2, color: up ? "var(--green)" : "var(--red)" }}>
                  {up ? "+" : ""}
                  {t.change24hPct.toFixed(1)}%
                </div>
              </div>

              <span className="tk-add">{on ? "✓" : "+"}</span>
            </button>
          );
        })}
      </div>

      <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "12px 0 0", lineHeight: 1.55 }}>
        Prices, 24-hour changes and volumes are live from Binance. Category chips are an editorial
        grouping — “All” is the full exchange list, and the chips only ever narrow it.{" "}
        <strong style={{ fontWeight: 600, color: "var(--ink-2)" }}>thin</strong> marks a pair whose
        daily volume is small enough that your own order moves the price;{" "}
        <strong style={{ fontWeight: 600, color: "var(--ink-2)" }}>like&nbsp;X</strong> marks a
        ticker that reads like a much larger one — the practical version of picking the wrong token.
      </p>
    </div>
  );
}
