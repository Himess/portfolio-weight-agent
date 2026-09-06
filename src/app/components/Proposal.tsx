"use client";

/**
 * Screen 3 — Proposal, and Screen 4 — Confirmation handoff (DESIGN.md §10).
 *
 * "The HOLD state needs its own visual treatment — it is a feature, not an
 *  empty state. Make it look like a decision, not like nothing happened."
 */

import { useState } from "react";

import { bps, ppAbs, qty, usd } from "@/lib/format";
import type { Proposal as ProposalType } from "@/types";

const FACTOR_LABEL: Record<string, string> = {
  cost: "Cost",
  volatility: "Volatility",
  falling_knife: "Move still in progress",
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
  const { timing, orderedTrades, context } = proposal;
  const cb = context.costBenefit;
  const hold = timing.action === "HOLD";
  const [headline, ...rest] = proposal.narrative.split("\n\n");
  const body = rest.join("\n\n");

  const anythingOutside = context.portfolio.rows.some(
    (r) => r.outsideBand && r.symbol !== context.cashSymbol,
  );

  const accent = hold
    ? anythingOutside
      ? "var(--color-accent)"
      : "var(--color-mut)"
    : "var(--color-buy)";

  return (
    <div className="rounded-2xl border bg-panel">
      <div className="border-b p-6" style={{ borderLeft: `3px solid ${accent}` }}>
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="rounded-md px-2.5 py-1 text-xs font-semibold tracking-wide"
            style={{ background: accent, color: "var(--color-ink)" }}
          >
            {timing.action}
          </span>
          <span className="text-xs text-mut">
            Deciding factor: {FACTOR_LABEL[timing.primaryFactor] ?? timing.primaryFactor}
          </span>
          {timing.fellBack && (
            <span
              className="rounded-md border px-2 py-0.5 text-[11px] text-mut"
              title={timing.fallbackReason}
            >
              deterministic fallback — no judgment applied
            </span>
          )}
        </div>

        <h2 className="mt-4 text-2xl font-semibold leading-snug">{headline}</h2>
        {body && <p className="mt-3 max-w-3xl leading-relaxed text-mut">{body}</p>}

        {hold && anythingOutside && (
          <p className="mt-4 max-w-3xl rounded-lg border bg-panel-2 p-3 text-sm text-mut">
            A threshold bot would have traded here — {ppAbs(context.portfolio.totalDriftPp)} of drift
            is past the band. Choosing not to act is the decision.
          </p>
        )}
      </div>

      {!hold && (
        <>
          <div className="grid grid-cols-2 gap-px border-b bg-line md:grid-cols-4">
            <Stat label="Estimated cost" value={usd(cb.estimatedCostUsd)} sub={bps(cb.costBps)} />
            <Stat label="Drift removed" value={ppAbs(cb.driftReductionPp)} sub={`to ${ppAbs(cb.totalDriftAfterPp)}`} />
            <Stat label="Cost per point" value={usd(cb.costPerPpUsd)} sub="per pp corrected" />
            <Stat label="Legs" value={String(orderedTrades.length)} sub="sells first, then buys" />
          </div>

          <div className="divide-y">
            {orderedTrades.map((t, i) => (
              <div key={t.id} className="flex flex-wrap items-center gap-4 px-6 py-4">
                <span className="tnum w-6 text-sm text-mut">{i + 1}</span>
                <span
                  className="w-12 rounded px-2 py-0.5 text-center text-xs font-semibold"
                  style={{
                    background: t.side === "BUY" ? "var(--color-buy)" : "var(--color-sell)",
                    color: "var(--color-ink)",
                  }}
                >
                  {t.side}
                </span>
                <span className="tnum min-w-40">
                  {qty(t.qty)} <span className="font-semibold">{t.symbol}</span>
                </span>
                <span className="tnum min-w-24 text-mut">{usd(t.estNotionalUsd)}</span>
                <span className="min-w-28 text-xs text-mut">{t.method.replace("_", " ")}</span>
                <span className="tnum min-w-32 text-xs text-mut">
                  fee {usd(t.estFeeUsd)} · slip {usd(t.estSlippageUsd)}
                </span>
                <span className="flex-1 text-xs text-mut">{t.why}</span>
              </div>
            ))}
          </div>

          {proposal.execution?.droppedCandidates.length ? (
            <div className="border-t px-6 py-3 text-xs text-mut">
              Dropped:{" "}
              {proposal.execution.droppedCandidates
                .map((d) => `${d.candidateId} (${d.why})`)
                .join(" · ")}
            </div>
          ) : null}
        </>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t p-6">
        {!hold && (
          <button
            onClick={onApprove}
            className="rounded-lg px-5 py-2.5 text-sm font-semibold"
            style={{ background: "var(--color-accent)", color: "var(--color-ink)" }}
          >
            Approve — send to Binance
          </button>
        )}
        <button onClick={onDismiss} className="rounded-lg border px-5 py-2.5 text-sm">
          {hold ? "Back to portfolio" : "Dismiss"}
        </button>
        <span className="text-xs text-mut">
          Approving sends each order to Binance, where you confirm it again before it executes.
        </span>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-panel p-5">
      <div className="text-[11px] uppercase tracking-widest text-mut">{label}</div>
      <div className="tnum mt-1 text-2xl font-semibold">{value}</div>
      <div className="mt-0.5 text-[11px] text-mut">{sub}</div>
    </div>
  );
}

/** Screen 4 — each order handed to Binance for the user's own confirmation. */
export function Handoff({
  proposal,
  onBack,
}: {
  proposal: ProposalType;
  onBack: () => void;
}) {
  const [sent, setSent] = useState<number>(-1);
  const trades = proposal.orderedTrades;

  return (
    <div className="rounded-2xl border bg-panel">
      <div className="border-b p-6">
        <h2 className="text-xl font-semibold">Confirmation handoff</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-mut">
          Orders go to Binance one at a time. Binance surfaces each one for you to confirm before it
          executes — this app cannot place an order on your behalf, and there is no withdrawal scope
          in the Binance MCP server, so funds can never leave your account through it.
        </p>
      </div>

      <div className="divide-y">
        {trades.map((t, i) => (
          <div key={t.id} className="flex flex-wrap items-center gap-4 px-6 py-4">
            <span className="tnum w-6 text-sm text-mut">{i + 1}</span>
            <span
              className="w-12 rounded px-2 py-0.5 text-center text-xs font-semibold"
              style={{
                background: t.side === "BUY" ? "var(--color-buy)" : "var(--color-sell)",
                color: "var(--color-ink)",
              }}
            >
              {t.side}
            </span>
            <span className="tnum flex-1">
              {qty(t.qty)} <span className="font-semibold">{t.symbol}</span>{" "}
              <span className="text-mut">on {t.pair}</span>
            </span>
            <span className="tnum text-mut">{usd(t.estNotionalUsd)}</span>
            {i <= sent ? (
              <span className="text-xs" style={{ color: "var(--color-accent)" }}>
                awaiting your confirmation in Binance
              </span>
            ) : (
              <button
                onClick={() => setSent(i)}
                disabled={i !== sent + 1}
                className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40"
              >
                Send order {i + 1}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 border-t p-6">
        <button onClick={onBack} className="rounded-lg border px-5 py-2.5 text-sm">
          Back
        </button>
        <span className="text-xs text-mut">
          Between orders the agent re-checks that the next leg is still valid; if drift has moved
          materially it stops and re-plans rather than continuing blindly.
        </span>
      </div>
    </div>
  );
}
