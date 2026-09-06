"use client";

/**
 * Screen 2 — Portfolio (DESIGN.md §10). The one that gets screenshotted.
 *
 * Hierarchy is deliberate: total drift is the largest thing on the page,
 * because it is the number that decides whether anything happens at all.
 * NAV is secondary. Everything else is a supporting row.
 */

import { Dev, Ring, Sparkline, Swatch, TokenLogo } from "./ui";
import { pct, pp, ppAbs, usd } from "@/lib/format";
import type { PortfolioState } from "@/types";

export function Portfolio({
  state,
  cashSymbol,
  series,
}: {
  state: PortfolioState;
  cashSymbol: string;
  /** Real hourly closes per symbol. Missing keys simply render no sparkline. */
  series?: Record<string, number[]>;
}) {
  const rows = state.rows.filter((r) => r.targetWeight > 0 || r.currentValueUsd > 0);
  // Ring shows the target allocation, ordered largest first so the ramp reads.
  const slices = [...rows]
    .filter((r) => r.targetWeight > 0)
    .sort((a, b) => b.targetWeight - a.targetWeight)
    .map((r) => ({ label: r.symbol, pct: r.targetWeight * 100 }));
  const ringIndex = new Map(slices.map((s, i) => [s.label, i]));

  const outside = rows.filter((r) => r.outsideBand && r.symbol !== cashSymbol);

  // Current weights keyed the same way as the ring slices, so the inner ring
  // and the legend read off one source.
  const currentByLabel = Object.fromEntries(
    rows.map((r) => [r.symbol, r.currentWeight * 100]),
  ) as Record<string, number>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ---- headline ---- */}
      <div className="card" style={{ padding: "26px 28px", display: "flex", flexWrap: "wrap", gap: 32, alignItems: "center" }}>
        <div style={{ flex: "1 1 320px", minWidth: 260 }}>
          <div className="lbl">Total drift</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 6 }}>
            <span
              className="m"
              style={{
                fontSize: 68,
                fontWeight: 700,
                letterSpacing: "-0.045em",
                lineHeight: 0.95,
                color: outside.length > 0 ? "var(--ink)" : "var(--ink-3)",
              }}
            >
              {ppAbs(state.totalDriftPp)}
            </span>
          </div>
          <p style={{ fontSize: 13.5, color: "var(--ink-2)", margin: "12px 0 0", maxWidth: "44ch", lineHeight: 1.55 }}>
            {outside.length > 0 ? (
              <>
                of the portfolio is away from target.{" "}
                <strong style={{ fontWeight: 600, color: "var(--ink)" }}>
                  {outside.map((r) => r.symbol).join(", ")}
                </strong>{" "}
                {outside.length === 1 ? "has" : "have"} crossed the tolerance band.
              </>
            ) : (
              <>of the portfolio is away from target — every position is still inside its band.</>
            )}
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <Ring
            slices={slices}
            totalPct={slices.reduce((a, s) => a + s.pct, 0)}
            current={currentByLabel}
            outsideCount={outside.length}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <div className="lbl" style={{ display: "flex", gap: 10, marginBottom: 2 }}>
              <span style={{ minWidth: 52 }} />
              <span style={{ minWidth: 34 }}>target</span>
              <span>now</span>
            </div>
            {slices.map((s, i) => {
              const now = currentByLabel[s.label] ?? 0;
              const moved = Math.abs(now - s.pct) >= 0.05;
              return (
                <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 52 }}>
                    <Swatch i={i} />
                    <span style={{ fontWeight: 600 }}>{s.label}</span>
                  </span>
                  <span className="m" style={{ color: "var(--ink-3)", minWidth: 34 }}>
                    {pct(s.pct, 0)}
                  </span>
                  <span
                    className="m"
                    style={{ fontWeight: moved ? 600 : 400, color: moved ? "var(--ink)" : "var(--ink-3)" }}
                  >
                    {pct(now, 0)}
                  </span>
                </div>
              );
            })}
            <div className="lbl" style={{ marginTop: 3, lineHeight: 1.4, maxWidth: 150 }}>
              outer ring: target · inner: where you actually are
            </div>
          </div>
        </div>

        <div style={{ borderLeft: "1px solid var(--line)", paddingLeft: 24, minWidth: 150 }}>
          <div className="lbl">Net asset value</div>
          <div className="m" style={{ fontSize: 26, fontWeight: 600, marginTop: 5, letterSpacing: "-0.02em" }}>
            {usd(state.navUsd)}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 6 }}>
            {new Date(state.asOf).toUTCString().replace("GMT", "UTC")}
          </div>
        </div>
      </div>

      {/* ---- positions ---- */}
      <div className="card">
        <div
          style={{ padding: "13px 22px", borderBottom: "1px solid var(--line)", gap: 16, gridTemplateColumns: "1.35fr 0.9fr 1.5fr 0.85fr 1fr" }}
          className="lbl poshead"
        >
          <span>Position</span>
          <span>Target / now</span>
          <span>Deviation from target</span>
          <span style={{ textAlign: "right" }}>Drift</span>
          <span style={{ textAlign: "right" }}>To return to target</span>
        </div>

        {rows.map((r) => {
          const isCash = r.symbol === cashSymbol;
          const i = ringIndex.get(r.symbol);
          const closes = series?.[r.symbol] ?? [];
          return (
            <div
              key={r.symbol}
              className="posrow"
              style={{ padding: "14px 22px", borderBottom: "1px solid var(--line)" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                {i != null ? <Swatch i={i} /> : <span style={{ width: 9 }} />}
                <TokenLogo symbol={r.symbol} size={28} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 14 }}>{r.symbol}</div>
                  <div className="m" style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>
                    {isCash ? "cash" : usd(r.currentValueUsd, { compact: true })}
                  </div>
                </div>
                {!isCash && <Sparkline closes={closes} />}
              </div>

              <div className="m" style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                {pct(r.targetWeight * 100)} <span style={{ color: "var(--ink-3)" }}>/</span>{" "}
                <span style={{ color: "var(--ink)", fontWeight: 600 }}>{pct(r.currentWeight * 100)}</span>
              </div>

              <div>
                <Dev driftPp={r.driftPp} bandPp={r.bandPp} />
                <div className="lbl" style={{ marginTop: 1 }}>
                  tolerance ±{r.bandPp.toFixed(1)}pp
                </div>
              </div>

              <div style={{ textAlign: "right" }}>
                <div
                  className="m"
                  style={{
                    fontSize: 15,
                    fontWeight: 650,
                    color: r.outsideBand ? (r.driftPp > 0 ? "var(--red)" : "var(--green)") : "var(--ink-3)",
                  }}
                >
                  {pp(r.driftPp)}
                </div>
                {r.outsideBand && (
                  <span className={`pill ${r.driftPp > 0 ? "pill-red" : "pill-green"}`} style={{ marginTop: 5, padding: "3px 9px", fontSize: 10.5 }}>
                    outside band
                  </span>
                )}
              </div>

              <div style={{ textAlign: "right" }}>
                <div className="m" style={{ fontSize: 13, fontWeight: 600 }}>
                  {isCash
                    ? `${r.deltaUsd > 0 ? "raise" : "deploy"} ${usd(Math.abs(r.deltaUsd), { compact: true })}`
                    : `${r.deltaUsd > 0 ? "buy" : "sell"} ${usd(Math.abs(r.deltaUsd), { compact: true })}`}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 3 }}>
                  {isCash ? "via the other legs" : "at current price"}
                </div>
              </div>
            </div>
          );
        })}

        <p style={{ fontSize: 11.5, color: "var(--ink-3)", padding: "13px 22px", margin: 0, lineHeight: 1.6 }}>
          Total drift is half the sum of absolute drifts — over- and under-weights mirror each other,
          so halving gives the share that actually changes hands. Bands are per position:
          max(2.0pp, 25% of the target weight), so a large holding tolerates more drift than a small one.
        </p>
      </div>
    </div>
  );
}
