"use client";

/**
 * What the agent decided, and why.
 *
 * Every decision was already recorded — verdict, deciding factor, the drift and
 * NAV at that moment, how many legs were proposed, whether they were approved,
 * and the reasoning in full. None of it was rendered. The app showed three
 * counters and kept the interesting part in localStorage.
 *
 * That was the wrong way round for this product in particular. The claim is
 * that the agent decides *when* to act and can decline; a claim like that is
 * worth nothing without a record, and `list_decisions` already existed over MCP
 * while the screen had no equivalent.
 *
 * Newest first, because the question is almost always "what did it just do".
 */

import { useMemo, useState } from "react";

import { all as allHistory, type HistoryEntry } from "@/lib/history";
import { pp } from "@/lib/format";

const VERDICT: Record<string, { label: string; cls: string }> = {
  REBALANCE: { label: "REBALANCE", cls: "pill pill-green" },
  PARTIAL: { label: "PARTIAL", cls: "pill pill-accent" },
  HOLD: { label: "HOLD", cls: "pill pill-quiet" },
};

/** Relative time, because an absolute timestamp answers a question nobody asked. */
function ago(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function Activity({
  summary,
  /** Bumped by the page after each review, so the list re-reads localStorage. */
  revision,
}: {
  summary: { total: number; holds: number; approved: number };
  revision: number;
}) {
  const [expanded, setExpanded] = useState(false);
  // localStorage is only readable on the client, and `revision` is what makes a
  // new decision show up without a reload.
  const entries = useMemo<HistoryEntry[]>(() => allHistory().slice().reverse(), [revision]);
  const now = Date.now();

  if (summary.total === 0) return null;

  const shown = expanded ? entries : entries.slice(0, 4);

  return (
    <div className="card card-p">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>What the agent has done</h2>
        <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>this browser only</span>
      </div>

      <div style={{ display: "flex", gap: 18, marginTop: 12 }}>
        {[
          { n: summary.total, l: "reviews" },
          { n: summary.holds, l: "held" },
          { n: summary.approved, l: "approved" },
        ].map((x) => (
          <div key={x.l}>
            <div className="m" style={{ fontSize: 19, fontWeight: 700 }}>
              {x.n}
            </div>
            <div className="lbl">{x.l}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, margin: "16px 0 0" }}>
        {shown.map((e) => {
          const v = VERDICT[e.action] ?? { label: e.action, cls: "pill pill-quiet" };
          return (
            <div
              key={e.at}
              style={{
                padding: "10px 12px",
                borderRadius: "var(--r-sm)",
                border: "1px solid var(--line)",
                background: "var(--surface-2)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                <span className={v.cls} style={{ fontSize: 10.5 }}>
                  {v.label}
                </span>
                <span className="m" style={{ fontSize: 11, color: "var(--ink-2)" }}>
                  {e.primaryFactor.replace(/_/g, " ")}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-3)" }}>
                  {ago(e.at, now)}
                </span>
              </div>

              {/* Figures from the record, never recomputed — this is what it saw. */}
              <div className="m" style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
                {pp(e.driftPp)} drift · {usd(e.navUsd)}
                {e.proposed > 0 ? ` · ${e.proposed} leg${e.proposed === 1 ? "" : "s"}` : " · nothing sent"}
                {e.approved ? " · approved" : ""}
                {e.fellBack ? " · band rule, no judgment layer" : ""}
              </div>

              {e.reasoning && (
                <p style={{ fontSize: 12, color: "var(--ink)", margin: "7px 0 0", lineHeight: 1.55 }}>
                  {e.reasoning}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {entries.length > 4 && (
        <button className="btn-link" style={{ marginTop: 10 }} onClick={() => setExpanded((x) => !x)}>
          {expanded ? "Show fewer" : `Show all ${entries.length}`}
        </button>
      )}

      <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "12px 0 0", lineHeight: 1.5 }}>
        Only an approved rebalance resets the clock the agent reads for staleness — a proposal you
        dismissed rebalanced nothing. The same record is available over MCP as{" "}
        <span className="m">list_decisions</span>.
      </p>
    </div>
  );
}
