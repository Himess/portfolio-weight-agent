"use client";

/**
 * Screen 3 — Proposal, including the HOLD state, and Screen 4 — Handoff.
 *
 * The HOLD state gets its own layout rather than an empty-state message. The
 * centrepiece is the trade that was prepared and refused, shown struck through:
 * the band was breached, the order was sized and priced, a rule would have
 * fired — and the agent declined. That contrast is the product.
 */

import { useState } from "react";

import { Say, Stat, TokenLogo } from "./ui";
import { bps, pct, ppAbs, qty, usd } from "@/lib/format";
import type { Proposal as ProposalType } from "@/types";

const FACTOR: Record<string, string> = {
  cost: "Cost",
  volatility: "Volatility",
  falling_knife: "Move still running",
  drift_magnitude: "Drift size",
  staleness: "Time since last rebalance",
};

export function ProposalView({
  proposal,
  onApprove,
  onDismiss,
}: {
  proposal: ProposalType;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  const { timing, context } = proposal;
  const [headline, ...rest] = proposal.narrative.split("\n\n");
  const body = rest.join("\n\n");

  const outside = context.portfolio.rows.filter(
    (r) => r.outsideBand && r.symbol !== context.cashSymbol,
  );

  if (timing.action === "HOLD") {
    return (
      <Hold
        proposal={proposal}
        headline={headline}
        body={body}
        anythingOutside={outside.length > 0}
        onDismiss={onDismiss}
      />
    );
  }

  const cb = context.costBenefit;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card" style={{ padding: "28px 30px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <span className="pill pill-accent" style={{ fontWeight: 700 }}>
            {timing.action}
          </span>
          <span className="pill pill-quiet">{FACTOR[timing.primaryFactor] ?? timing.primaryFactor}</span>
          {timing.fellBack && (
            <span className="pill" title={timing.fallbackReason}>
              deterministic fallback — no judgment applied
            </span>
          )}
        </div>

        <Say line={headline}>{body}</Say>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 16 }}>
        <Tile label="Estimated cost" value={usd(cb.estimatedCostUsd)} note={bps(cb.costBps)} />
        <Tile label="Drift removed" value={ppAbs(cb.driftReductionPp)} note={`leaves ${ppAbs(cb.totalDriftAfterPp)}`} />
        <Tile label="Cost per point" value={usd(cb.costPerPpUsd)} note="per pp corrected" />
        <Tile label="Legs" value={String(proposal.orderedTrades.length)} note="sells first, then buys" />
      </div>

      <div className="card">
        <div className="lbl" style={{ padding: "13px 22px", borderBottom: "1px solid var(--line)" }}>
          The plan
        </div>
        {proposal.orderedTrades.map((t, i) => (
          <div
            key={t.id}
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 14,
              padding: "15px 22px",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <span className="m" style={{ width: 18, color: "var(--ink-3)", fontSize: 12 }}>
              {i + 1}
            </span>
            <span className={`pill ${t.side === "BUY" ? "pill-green" : "pill-red"}`} style={{ fontWeight: 700 }}>
              {t.side}
            </span>
            <TokenLogo symbol={t.symbol} size={28} />
            <div style={{ minWidth: 170 }}>
              <div style={{ fontSize: 14.5, fontWeight: 650 }}>
                <span className="m">{qty(t.qty)}</span> {t.symbol}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 3 }}>
                {t.method.replace("_", " ")} · {t.pair}
              </div>
            </div>
            <div className="m" style={{ fontSize: 14.5, fontWeight: 600, minWidth: 90 }}>
              {usd(t.estNotionalUsd)}
            </div>
            <div className="m" style={{ fontSize: 11.5, color: "var(--ink-3)", minWidth: 150 }}>
              fee {usd(t.estFeeUsd)} · slip {usd(t.estSlippageUsd)}
            </div>
            <div style={{ flex: 1, fontSize: 12.5, color: "var(--ink-2)", minWidth: 180 }}>{t.why}</div>
          </div>
        ))}

        {proposal.execution?.droppedCandidates.length ? (
          <div style={{ padding: "12px 22px", fontSize: 12, color: "var(--ink-3)" }}>
            Dropped: {proposal.execution.droppedCandidates.map((d) => `${d.candidateId} — ${d.why}`).join(" · ")}
          </div>
        ) : null}

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "18px 22px" }}>
          <button className="btn btn-primary" onClick={onApprove}>
            Approve — send to Binance
          </button>
          <button className="btn" onClick={onDismiss}>
            Not now
          </button>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            Each order is confirmed by you in Binance before it executes.
          </span>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="card card-p">
      <div className="lbl">{label}</div>
      <div className="m" style={{ fontSize: 25, fontWeight: 650, marginTop: 6, letterSpacing: "-0.02em" }}>
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 4 }}>{note}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HOLD
// ---------------------------------------------------------------------------

function Hold({
  proposal,
  headline,
  body,
  anythingOutside,
  onDismiss,
}: {
  proposal: ProposalType;
  headline: string;
  body: string;
  anythingOutside: boolean;
  onDismiss: () => void;
}) {
  const { timing, context } = proposal;
  const refused = context.candidates;
  const sig = context.signals;

  const worst = [...context.portfolio.rows]
    .filter((r) => r.symbol !== context.cashSymbol)
    .sort((a, b) => Math.abs(b.driftPp) - Math.abs(a.driftPp))[0];
  const worstSig = sig.find((s) => s.symbol === worst?.symbol);

  const rows: { label: string; value: string; tone?: "green" | "red" | "amber" | "ink" }[] = [];
  if (worst) {
    rows.push({
      label: `${worst.symbol} deviation`,
      value: `${worst.driftPp > 0 ? "+" : ""}${worst.driftPp.toFixed(1)}pp`,
      tone: worst.outsideBand ? "red" : "ink",
    });
    rows.push({ label: "Its tolerance", value: `${worst.bandPp.toFixed(1)}pp` });
  }
  if (worstSig) {
    rows.push({
      label: "4-hour move",
      value: `${worstSig.priceChange4hPct > 0 ? "+" : ""}${worstSig.priceChange4hPct.toFixed(1)}%`,
      tone: worstSig.priceChange4hPct > 0 ? "green" : "red",
    });
    rows.push({
      label: "24-hour move",
      value: `${worstSig.priceChange24hPct > 0 ? "+" : ""}${worstSig.priceChange24hPct.toFixed(1)}%`,
      tone: worstSig.priceChange24hPct > 0 ? "green" : "red",
    });
    rows.push({
      label: "Volatility ratio",
      value: `${worstSig.volRatio.toFixed(2)}×`,
      tone: worstSig.volRatio > 1.3 ? "amber" : "ink",
    });
  }
  rows.push({ label: "Cost to correct", value: usd(context.costBenefit.estimatedCostUsd) });
  rows.push({ label: "Trades refused", value: String(refused.length) });

  return (
    <div className="split split-hold">
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        <div className="card" style={{ padding: "28px 30px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 18 }}>
            <span className="pill pill-accent" style={{ fontWeight: 700 }}>
              HOLD
            </span>
            <span className="pill pill-quiet">{FACTOR[timing.primaryFactor] ?? timing.primaryFactor}</span>
            {timing.fellBack && (
              <span className="pill" title={timing.fallbackReason}>
                deterministic fallback — no judgment applied
              </span>
            )}
          </div>
          <Say line={headline}>{body}</Say>
        </div>

        {anythingOutside && refused.length > 0 && (
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>What a threshold bot would have done</div>
            <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "7px 0 15px", maxWidth: "60ch", lineHeight: 1.55 }}>
              {refused.length === 1 ? "This trade was" : "These trades were"} sized, priced and ready to
              send. The band was breached, so a rule would have fired. The agent read the same numbers
              and declined.
            </p>

            <div className="refused">
              {refused.map((t, i) => (
                <div
                  key={t.id}
                  className="refused-row"
                  style={{ marginTop: i === 0 ? 0 : 14 }}
                >
                  <TokenLogo symbol={t.symbol} size={32} />
                  <div style={{ flex: 1 }}>
                    <div className="strike" style={{ fontSize: 15.5, fontWeight: 650 }}>
                      {t.side === "SELL" ? "Sell" : "Buy"} <span className="m">{qty(t.qty)}</span> {t.symbol}
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 4 }}>
                      {/* No execution method to report: this candidate never reached
                          the execution decision, because timing stopped it first. */}
                      Sized against live depth · {t.slippageBps.toFixed(1)} bps expected slippage
                    </div>
                  </div>
                  <div className="m strike" style={{ fontSize: 15.5, fontWeight: 650 }}>
                    {usd(t.estNotionalUsd)}
                  </div>
                </div>
              ))}
              <div className="refused-verdict">
                <span style={{ fontSize: 11 }}>✕</span>
                Refused — {timing.reasoning.split(/(?<=\.)\s/)[0]}
              </div>
            </div>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button className="btn" onClick={onDismiss}>
            Check again later
          </button>
          <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
            Nothing was sent. Your portfolio is untouched.
          </span>
        </div>
      </div>

      <Stat
        title="What the agent looked at"
        note="Every figure computed in code, none written by the model."
        rows={rows}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

export function Handoff({ proposal, onBack }: { proposal: ProposalType; onBack: () => void }) {
  const [sent, setSent] = useState(-1);
  const trades = proposal.orderedTrades;

  return (
    <div className="card">
      <div style={{ padding: "26px 28px", borderBottom: "1px solid var(--line)" }}>
        <h2 style={{ fontSize: 21, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          Confirmation handoff
        </h2>
        <p style={{ fontSize: 13.5, color: "var(--ink-2)", margin: "10px 0 0", maxWidth: "64ch", lineHeight: 1.6 }}>
          Orders go to Binance one at a time, and Binance surfaces each one for you to confirm before
          it executes. This app cannot place an order on your behalf. There is no withdrawal scope in
          the Binance MCP server, so funds cannot leave your account through it.
        </p>
      </div>

      {trades.map((t, i) => (
        <div
          key={t.id}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 14,
            padding: "15px 28px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <span className="m" style={{ width: 18, color: "var(--ink-3)", fontSize: 12 }}>
            {i + 1}
          </span>
          <span className={`pill ${t.side === "BUY" ? "pill-green" : "pill-red"}`} style={{ fontWeight: 700 }}>
            {t.side}
          </span>
          <div style={{ flex: 1, fontSize: 14.5, minWidth: 200 }}>
            <span className="m" style={{ fontWeight: 600 }}>
              {qty(t.qty)}
            </span>{" "}
            {t.symbol} <span style={{ color: "var(--ink-3)" }}>on {t.pair}</span>
          </div>
          <div className="m" style={{ fontSize: 14, fontWeight: 600 }}>
            {usd(t.estNotionalUsd)}
          </div>
          {i <= sent ? (
            <span className="pill pill-accent">awaiting your confirmation in Binance</span>
          ) : (
            <button className="btn" disabled={i !== sent + 1} onClick={() => setSent(i)} style={{ padding: "8px 14px", fontSize: 12 }}>
              Send order {i + 1}
            </button>
          )}
        </div>
      ))}

      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 28px" }}>
        <button className="btn" onClick={onBack}>
          Back
        </button>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
          Between orders the agent re-checks the next leg; if drift has moved materially it stops and
          re-plans rather than continuing blindly.
        </span>
      </div>
    </div>
  );
}
