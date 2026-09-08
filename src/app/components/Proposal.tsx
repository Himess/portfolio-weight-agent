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

/**
 * The product's thesis, stated only when the plan actually does it.
 *
 * Rebalancing means selling what rose and buying what fell, which is the part
 * people cannot make themselves do. When the plan has that shape, say so — but
 * derive it from the figures rather than asserting it, because a plan that
 * happens not to do it should not claim otherwise.
 */
function contrarianLine(proposal: ProposalType): string | null {
  const { context, orderedTrades } = proposal;
  if (orderedTrades.length === 0) return null;

  const change = new Map(context.signals.map((s) => [s.symbol, s.priceChange24hPct]));
  const traded = orderedTrades
    .map((t) => ({ side: t.side, symbol: t.symbol, chg: change.get(t.symbol) }))
    .filter((t): t is { side: "BUY" | "SELL"; symbol: string; chg: number } =>
      typeof t.chg === "number" && Number.isFinite(t.chg),
    );
  if (traded.length === 0) return null;

  const sells = traded.filter((t) => t.side === "SELL").sort((a, b) => b.chg - a.chg);
  const buys = traded.filter((t) => t.side === "BUY").sort((a, b) => a.chg - b.chg);

  const risingSell = sells[0] && sells[0].chg > 0 ? sells[0] : null;
  const fallingBuy = buys[0] && buys[0].chg < 0 ? buys[0] : null;

  // "down -2.5%" is a double negative; the word already carries the sign.
  const mag = (n: number) => `${Math.abs(n).toFixed(1)}%`;

  if (risingSell && fallingBuy) {
    return `This sells ${risingSell.symbol}, up ${mag(risingSell.chg)} today, and buys ${fallingBuy.symbol}, down ${mag(fallingBuy.chg)}. That is the trade most people cannot make themselves.`;
  }
  if (risingSell) {
    return `This trims ${risingSell.symbol} while it is up ${mag(risingSell.chg)} today — selling into strength, which is the part that feels wrong and is the point.`;
  }
  if (fallingBuy) {
    return `This buys ${fallingBuy.symbol} while it is down ${mag(fallingBuy.chg)} today — adding to a loser, which is the part that feels wrong and is the point.`;
  }
  return null;
}

const FACTOR: Record<string, string> = {
  cost: "Cost",
  volatility: "Volatility",
  falling_knife: "Move still running",
  drift_magnitude: "Drift size",
  staleness: "Time since last rebalance",
  attention: "Saving your attention",
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
  const contrarian = contrarianLine(proposal);

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

        {contrarian && (
          <div
            style={{
              marginTop: 20,
              padding: "14px 16px",
              borderRadius: "var(--r-inner)",
              background: "var(--accent-soft)",
              border: "1px solid var(--accent-line)",
              fontSize: 13.5,
              lineHeight: 1.55,
              color: "var(--accent-ink)",
              maxWidth: "68ch",
            }}
          >
            {contrarian}
          </div>
        )}

        <DriftBeforeAfter
          before={cb.totalDriftBeforePp}
          after={cb.totalDriftAfterPp}
        />
      </div>

      {/* min() so a narrow phone shrinks the tracks instead of widening the page. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(170px,100%),1fr))", gap: 16 }}>
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
                {/*
                  A limit order is a different instruction from a market order
                  and the offset is the whole of it. "spot limit" alone told the
                  reader nothing about where it would rest.
                */}
                {t.method === "spot_limit"
                  ? `limit, ${t.limitPriceOffsetBps}bps inside`
                  : t.method.replace("_", " ")}{" "}
                · {t.pair}
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

        {/*
          The legs it turned down, in the same card as the ones it is sending.
          This is the whole difference from a threshold rule and it existed only
          in the payload: a bot fires every breached leg, and here two positions
          crossed the same band in the same check and got different answers.
          Side by side is the only way that reads at a glance.
        */}
        {proposal.declined.length > 0 && (
          <div style={{ borderTop: "1px solid var(--line)" }}>
            <div className="lbl" style={{ padding: "13px 22px", color: "var(--ink-3)" }}>
              Declined in the same check
            </div>
            {proposal.declined.map((c) => (
              <div
                key={c.id}
                className="refused-row"
                style={{ padding: "0 22px 14px", display: "flex", alignItems: "center", gap: 14 }}
              >
                <TokenLogo symbol={c.symbol} size={28} />
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div className="strike" style={{ fontSize: 14.5, fontWeight: 650 }}>
                    {c.side === "SELL" ? "Sell" : "Buy"} <span className="m">{qty(c.qty)}</span>{" "}
                    {c.symbol}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 3 }}>
                    sized against live depth · {c.slippageBps.toFixed(1)} bps expected slippage
                  </div>
                </div>
                <div className="m strike" style={{ fontSize: 14.5, fontWeight: 650, minWidth: 90 }}>
                  {usd(c.estNotionalUsd)}
                </div>
              </div>
            ))}
            <div style={{ padding: "0 22px 16px", fontSize: 12.5, color: "var(--ink-2)", maxWidth: "68ch", lineHeight: 1.55 }}>
              Outside the same band as the legs above, and not sent —{" "}
              {FACTOR[timing.primaryFactor]?.toLowerCase() ?? timing.primaryFactor}.{" "}
              {timing.reasoning.split(/(?<=[.!?])\s/).slice(-1)[0]}
            </div>
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "18px 22px" }}>
          <button className="btn btn-primary" onClick={onApprove}>
            Approve this plan
          </button>
          <button className="btn" onClick={onDismiss}>
            Not now
          </button>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            Approving records the decision and shows you the orders. Nothing is sent from here.
          </span>
        </div>
      </div>
    </div>
  );
}

/** Drift before and after, on one scale, so the correction has a size. */
function DriftBeforeAfter({ before, after }: { before: number; after: number }) {
  const max = Math.max(before, after, 0.1);
  const w = (v: number) => `${Math.max(2, (v / max) * 100)}%`;
  return (
    <div style={{ marginTop: 22, maxWidth: 460 }}>
      <div className="lbl" style={{ marginBottom: 8 }}>
        Drift, before and after
      </div>
      {[
        { label: "now", v: before, color: "var(--ink)" },
        { label: "after", v: after, color: "var(--green)" },
      ].map((row) => (
        <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
          <span style={{ fontSize: 11.5, color: "var(--ink-3)", width: 36 }}>{row.label}</span>
          <div className="meter" style={{ flex: 1 }}>
            <span style={{ width: w(row.v), background: row.color }} />
          </div>
          <span className="m" style={{ fontSize: 12.5, fontWeight: 600, width: 52, textAlign: "right" }}>
            {row.v.toFixed(1)}pp
          </span>
        </div>
      ))}
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
          <b style={{ color: "var(--ink)" }}>This app does not place orders — it hands them to you.</b>{" "}
          Place each one in Binance, or ask your MCP client to send it through the Binance server,
          where Binance asks you to confirm it. Then tick it off here, one at a time, so the
          sequence stays in the order the plan needs. There is no withdrawal scope in the Binance
          MCP server, so funds cannot leave your account through it either way.
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
            <span className="pill pill-green">placed</span>
          ) : (
            <button className="btn" disabled={i !== sent + 1} onClick={() => setSent(i)} style={{ padding: "8px 14px", fontSize: 12 }}>
              Mark {i + 1} as placed
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
