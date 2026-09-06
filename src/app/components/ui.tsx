"use client";

/**
 * Shared display primitives.
 *
 * Structure follows PortfolioAgentUI.jsx (allocation ring, deviation meter,
 * sparkline, the prose-with-figures pattern). None of its visual language is
 * carried over — colors, dark theme, glass and gradients are all dropped in
 * favour of the GhostRail tokens in tokens.css.
 *
 * Two deliberate departures from the reference:
 *
 *  - Its sparkline synthesises a price series from a hash of the ticker, and
 *    its token list hard-codes prices. Both would put invented numbers on
 *    screen, which DESIGN.md §2 forbids. Sparkline here plots real closes and
 *    renders nothing when it has none.
 *  - Its ring paints each slice a different brand hue. Identity is already
 *    carried by the labels beside it, and five competing hues fail a
 *    colourblind check on this background (measured: worst pair ΔE 4.8 under
 *    deuteranopia, against a floor of 8). This uses one ordered lightness
 *    ramp instead — monotonic, every step ≥3:1 on white.
 */

import { useId } from "react";

/** Ordered ink ramp for ring segments: largest holding darkest. */
export const RING_RAMP = ["#2b2926", "#44413b", "#5d5952", "#787269", "#948e82"];

export function ringColor(i: number): string {
  return RING_RAMP[Math.min(i, RING_RAMP.length - 1)];
}

// ---------------------------------------------------------------------------
// Allocation ring
// ---------------------------------------------------------------------------

export function Ring({
  slices,
  totalPct,
  size = 148,
}: {
  slices: { label: string; pct: number }[];
  totalPct: number;
  size?: number;
}) {
  const stroke = 16;
  const r = (size - stroke) / 2 - 1;
  const c = 2 * Math.PI * r;
  const onTarget = Math.abs(totalPct - 100) < 0.05;

  let acc = 0;
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} stroke="var(--line)" />
        {slices.map((s, i) => {
          const len = (Math.max(s.pct, 0) / Math.max(totalPct, 100)) * c;
          const off = acc;
          acc += len;
          return (
            <circle
              key={s.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              strokeWidth={stroke}
              stroke={ringColor(i)}
              /* 2px of surface between segments, per the mark spec */
              strokeDasharray={`${Math.max(len - 2, 0)} ${c}`}
              strokeDashoffset={-off}
              style={{ transition: "stroke-dasharray .4s cubic-bezier(.4,0,.2,1), stroke-dashoffset .4s cubic-bezier(.4,0,.2,1)" }}
            />
          );
        })}
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center" }}>
          <div
            className="m"
            style={{
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: "-0.04em",
              color: onTarget ? "var(--ink)" : "var(--amber)",
            }}
          >
            {totalPct.toFixed(0)}%
          </div>
          <div className="lbl" style={{ marginTop: 2 }}>
            allocated
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deviation meter
// ---------------------------------------------------------------------------

/**
 * A signed deviation from target, with the tolerance band drawn as a region.
 * The question it answers at a glance is "is this outside its band, and which
 * way" — which a plain progress bar cannot show.
 */
export function Dev({
  driftPp,
  bandPp,
  scale,
}: {
  driftPp: number;
  bandPp: number;
  /** Half-width of the axis in pp. Defaults to whichever is larger. */
  scale?: number;
}) {
  const s = Math.max(scale ?? 0, bandPp * 1.9, Math.abs(driftPp) * 1.25, 3);
  const at = (v: number) => 50 + (v / s) * 50;
  const outside = Math.abs(driftPp) > bandPp;
  const color = outside ? (driftPp > 0 ? "var(--red)" : "var(--green)") : "var(--ink-3)";
  const pos = Math.max(1, Math.min(99, at(driftPp)));

  return (
    <div
      className="dev"
      role="img"
      aria-label={`${driftPp > 0 ? "over" : "under"} target by ${Math.abs(driftPp).toFixed(1)} percentage points, tolerance ${bandPp.toFixed(1)}`}
    >
      <div className="dev-band" style={{ left: `${at(-bandPp)}%`, width: `${at(bandPp) - at(-bandPp)}%` }} />
      <div className="dev-axis" />
      <div
        className="dev-fill"
        style={{ left: `${Math.min(50, pos)}%`, width: `${Math.abs(pos - 50)}%`, background: color }}
      />
      <div className="dev-pin" style={{ left: `calc(${pos}% - 1.5px)`, background: color }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline — real closes only
// ---------------------------------------------------------------------------

export function Sparkline({
  closes,
  width = 58,
  height = 26,
}: {
  closes: number[];
  width?: number;
  height?: number;
}) {
  const id = useId();
  const clean = closes.filter((n) => Number.isFinite(n) && n > 0);
  // No invented data: with nothing real to plot, plot nothing.
  if (clean.length < 3) return <div style={{ width, height, flex: "none" }} />;

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const pad = 2;
  const pts = clean.map((v, i) => {
    const x = (i / (clean.length - 1)) * width;
    const y = height - pad - ((v - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const up = clean[clean.length - 1] >= clean[0];

  return (
    <svg width={width} height={height} style={{ flex: "none", display: "block" }} aria-hidden="true">
      <defs>
        <linearGradient id={`f${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={up ? "var(--green)" : "var(--red)"} stopOpacity="0.14" />
          <stop offset="100%" stopColor={up ? "var(--green)" : "var(--red)"} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${pts.join(" ")} ${width},${height}`} fill={`url(#f${id})`} />
      <polyline
        points={pts.join(" ")}
        fill="none"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke={up ? "var(--green)" : "var(--red)"}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Prose with figures
// ---------------------------------------------------------------------------

/** A figure inside prose. Monospaced so it reads as measured, not written. */
export function N({ children }: { children: React.ReactNode }) {
  return (
    <span className="m" style={{ fontWeight: 600, color: "var(--ink)" }}>
      {children}
    </span>
  );
}

export function Say({ line, children }: { line: string; children?: React.ReactNode }) {
  return (
    <div>
      <h2 style={{ fontSize: 25, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.22, margin: 0 }}>
        {line}
      </h2>
      {children && (
        <p
          style={{
            fontSize: 14.5,
            lineHeight: 1.6,
            color: "var(--ink-2)",
            margin: "14px 0 0",
            maxWidth: "58ch",
          }}
        >
          {children}
        </p>
      )}
    </div>
  );
}

/** The panel that shows what the agent actually looked at. */
export function Stat({
  title,
  note,
  rows,
}: {
  title: string;
  note?: string;
  rows: { label: string; value: string; tone?: "green" | "red" | "amber" | "ink" }[];
}) {
  const tone = (t?: string) =>
    t === "green" ? "var(--green)" : t === "red" ? "var(--red)" : t === "amber" ? "var(--amber)" : "var(--ink)";
  return (
    <div className="card card-p">
      <div style={{ fontSize: 13.5, fontWeight: 700 }}>{title}</div>
      {note && (
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 5, lineHeight: 1.5 }}>{note}</div>
      )}
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column" }}>
        {rows.map((r, i) => (
          <div
            key={r.label}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: 16,
              padding: "9px 0",
              borderTop: i === 0 ? "none" : "1px solid var(--line)",
            }}
          >
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{r.label}</span>
            <span className="m" style={{ fontSize: 13, fontWeight: 600, color: tone(r.tone) }}>
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A small square swatch tying a list row to its ring segment. */
export function Swatch({ i }: { i: number }) {
  return (
    <span
      style={{
        width: 9,
        height: 9,
        borderRadius: 3,
        background: ringColor(i),
        flex: "none",
        display: "inline-block",
      }}
    />
  );
}
