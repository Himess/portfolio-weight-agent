"use client";

/** Screen 2 — Portfolio view (DESIGN.md §10). The screenshot-worthy one. */

import { pct, pp, ppAbs, usd } from "@/lib/format";
import type { PortfolioState } from "@/types";

export function Portfolio({
  state,
  cashSymbol,
}: {
  state: PortfolioState;
  cashSymbol: string;
}) {
  const rows = state.rows.filter((r) => r.targetWeight > 0 || r.currentValueUsd > 0);
  const maxWeight = Math.max(0.01, ...rows.map((r) => Math.max(r.targetWeight, r.currentWeight)));

  return (
    <div className="rounded-2xl border bg-panel">
      <div className="flex flex-wrap items-end justify-between gap-6 border-b p-6">
        <div>
          <div className="text-xs uppercase tracking-widest text-mut">Total drift</div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="tnum text-5xl font-semibold tabular-nums">
              {ppAbs(state.totalDriftPp)}
            </span>
            <span className="text-sm text-mut">of the portfolio must change hands</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-widest text-mut">Net asset value</div>
          <div className="tnum mt-1 text-3xl font-semibold">{usd(state.navUsd)}</div>
          <div className="mt-1 text-xs text-mut">{new Date(state.asOf).toUTCString()}</div>
        </div>
      </div>

      <div className="divide-y">
        {rows.map((r) => {
          const targetPct = (r.targetWeight / maxWeight) * 100;
          const currentPct = (r.currentWeight / maxWeight) * 100;
          const over = r.driftPp > 0;
          return (
            <div key={r.symbol} className="grid grid-cols-12 items-center gap-4 px-6 py-4">
              <div className="col-span-2">
                <div className="font-semibold">{r.symbol}</div>
                <div className="text-xs text-mut">
                  {r.symbol === cashSymbol ? "cash" : usd(r.currentValueUsd, { compact: true })}
                </div>
              </div>

              <div className="col-span-6">
                <div className="driftbar">
                  <div
                    className="driftbar__fill"
                    style={{
                      width: `${Math.min(100, currentPct)}%`,
                      background: r.outsideBand
                        ? over
                          ? "var(--color-sell)"
                          : "var(--color-buy)"
                        : "var(--color-line)",
                    }}
                  />
                  <div className="driftbar__target" style={{ left: `${Math.min(100, targetPct)}%` }} />
                </div>
                <div className="mt-1.5 flex gap-4 text-[11px] text-mut">
                  <span>target {pct(r.targetWeight * 100)}</span>
                  <span>now {pct(r.currentWeight * 100)}</span>
                  <span>band ±{r.bandPp.toFixed(1)}pp</span>
                </div>
              </div>

              <div className="col-span-2 text-right">
                <div
                  className="tnum text-lg font-medium"
                  style={{
                    color: r.outsideBand
                      ? over
                        ? "var(--color-sell)"
                        : "var(--color-buy)"
                      : "var(--color-mut)",
                  }}
                >
                  {pp(r.driftPp)}
                </div>
                <div className="text-[11px] text-mut">
                  {r.outsideBand ? "outside band" : "within band"}
                </div>
              </div>

              <div className="col-span-2 text-right">
                {r.symbol === cashSymbol ? (
                  <>
                    {/* Cash is never traded against itself — its drift is
                        resolved by the other legs, so "sell $X of USDT" would
                        be nonsense. Say what actually happens instead. */}
                    <div className="tnum text-sm">
                      {r.deltaUsd > 0 ? "raise " : "deploy "}
                      {usd(Math.abs(r.deltaUsd), { compact: true })}
                    </div>
                    <div className="text-[11px] text-mut">via the other legs</div>
                  </>
                ) : (
                  <>
                    <div className="tnum text-sm">
                      {r.deltaUsd > 0 ? "buy " : "sell "}
                      {usd(Math.abs(r.deltaUsd), { compact: true })}
                    </div>
                    <div className="text-[11px] text-mut">to return to target</div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="border-t px-6 py-3 text-xs text-mut">
        Total drift is half the sum of absolute drifts — over- and under-weights always mirror each
        other, so halving gives the share that actually changes hands. Bands are per position:
        max(2.0pp, 25% of the target weight).
      </p>
    </div>
  );
}
