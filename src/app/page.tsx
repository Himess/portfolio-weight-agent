"use client";

/**
 * Four screens, nothing more (DESIGN.md §10):
 *   1. Set allocation   2. Portfolio view   3. Proposal   4. Confirmation handoff
 */

import { useEffect, useMemo, useState } from "react";

import { Portfolio } from "./components/Portfolio";
import { Handoff, ProposalView } from "./components/Proposal";
import { validateAllocation } from "@/core/allocation";
import { pct } from "@/lib/format";
import type {
  Allocation,
  BasketResolution,
  Preference,
  Proposal,
  Target,
} from "@/types";

type Screen = "allocate" | "portfolio" | "proposal" | "handoff";

const DEFAULT_TARGETS: Target[] = [
  { kind: "asset", symbol: "BTC", weight: 0.4 },
  { kind: "asset", symbol: "ETH", weight: 0.2 },
  {
    kind: "basket",
    label: "L1s",
    weight: 0.3,
    members: [
      { symbol: "SOL", weight: 0.5, why: "Large-cap alternative L1" },
      { symbol: "AVAX", weight: 0.5, why: "Large-cap alternative L1" },
    ],
    resolvedAt: "2026-01-01T00:00:00.000Z",
    rationale: "Starting example — resolve your own category to replace this.",
  },
  { kind: "asset", symbol: "USDT", weight: 0.1 },
];

type Ctx = {
  llmAvailable: boolean;
  model: string;
  datasets: string[];
  replay: { label: string | null; symbols: string[]; interval: string; bars: number } | null;
};

export default function Page() {
  const [screen, setScreen] = useState<Screen>("allocate");
  const [targets, setTargets] = useState<Target[]>(DEFAULT_TARGETS);
  const [cashSymbol] = useState("USDT");
  const [preference, setPreference] = useState<Preference>("balanced");
  const [ctx, setCtx] = useState<Ctx | null>(null);

  const [source, setSource] = useState<"replay" | "public">("replay");
  const [bar, setBar] = useState(8500);
  const [seedBar, setSeedBar] = useState(30);

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/context")
      .then((r) => r.json())
      .then((c: Ctx) => {
        setCtx(c);
        if (c.replay) setBar(Math.max(60, c.replay.bars - 1));
        if (!c.replay) setSource("public");
      })
      .catch(() => setError("Could not load context."));
  }, []);

  const allocation: Allocation = useMemo(() => ({ targets, cashSymbol }), [targets, cashSymbol]);
  const validation = useMemo(() => validateAllocation(allocation), [allocation]);
  const totalWeight = targets.reduce((a, t) => a + t.weight, 0);

  async function review() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allocation,
          preference,
          source,
          bar,
          seedBar: source === "replay" ? seedBar : undefined,
          seedNavUsd: 100_000,
          daysSinceLastRebalance: source === "replay" ? Math.round((bar - seedBar) / 24) : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Review failed.");
      setProposal(json.proposal as Proposal);
      setScreen("portfolio");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Portfolio Weight Agent</h1>
            <p className="mt-1 max-w-2xl text-sm text-mut">
              Selling your winners and buying your losers is psychologically hard. The agent
              proposes it; you approve it.
            </p>
          </div>
          <div className="text-right text-xs text-mut">
            {ctx && (
              <>
                <div>
                  judgment layer:{" "}
                  <span style={{ color: ctx.llmAvailable ? "var(--color-buy)" : "var(--color-accent)" }}>
                    {ctx.llmAvailable ? ctx.model : "unavailable — deterministic fallback"}
                  </span>
                </div>
                <div className="mt-0.5">
                  math: deterministic, always
                </div>
              </>
            )}
          </div>
        </div>

        <nav className="mt-6 flex gap-1 text-sm">
          {(["allocate", "portfolio", "proposal", "handoff"] as Screen[]).map((s, i) => {
            const reachable =
              s === "allocate" || (proposal != null && (s !== "handoff" || proposal.orderedTrades.length > 0));
            return (
              <button
                key={s}
                disabled={!reachable}
                onClick={() => setScreen(s)}
                className="rounded-lg px-3 py-1.5 capitalize disabled:opacity-30"
                style={{
                  background: screen === s ? "var(--color-panel-2)" : "transparent",
                  color: screen === s ? "var(--color-fg)" : "var(--color-mut)",
                }}
              >
                {i + 1}. {s}
              </button>
            );
          })}
        </nav>
      </header>

      {error && (
        <div className="mb-6 rounded-xl border p-4 text-sm" style={{ borderColor: "var(--color-sell)" }}>
          {error}
        </div>
      )}

      {screen === "allocate" && (
        <AllocateScreen
          targets={targets}
          setTargets={setTargets}
          totalWeight={totalWeight}
          validation={validation}
          preference={preference}
          setPreference={setPreference}
          ctx={ctx}
          source={source}
          setSource={setSource}
          bar={bar}
          setBar={setBar}
          seedBar={seedBar}
          setSeedBar={setSeedBar}
          onReview={review}
          busy={busy}
        />
      )}

      {screen === "portfolio" && proposal && (
        <div className="space-y-6">
          <Portfolio state={proposal.context.portfolio} cashSymbol={cashSymbol} />
          <div className="flex gap-3">
            <button
              onClick={() => setScreen("proposal")}
              className="rounded-lg px-5 py-2.5 text-sm font-semibold"
              style={{ background: "var(--color-accent)", color: "var(--color-ink)" }}
            >
              See what the agent decided
            </button>
            <button onClick={review} disabled={busy} className="rounded-lg border px-5 py-2.5 text-sm">
              {busy ? "Reviewing…" : "Re-run review"}
            </button>
          </div>
        </div>
      )}

      {screen === "proposal" && proposal && (
        <ProposalView
          proposal={proposal}
          onApprove={() => setScreen("handoff")}
          onDismiss={() => setScreen("portfolio")}
        />
      )}

      {screen === "handoff" && proposal && (
        <Handoff proposal={proposal} onBack={() => setScreen("proposal")} />
      )}

      <footer className="mt-12 border-t pt-6 text-xs leading-relaxed text-mut">
        Not investment advice. You are the decision-maker: every order requires your confirmation in
        Binance before it executes. The agent chooses and explains; every quantity, price and
        percentage on this page is computed by deterministic code, never by the model.
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Screen 1 — Set allocation
// ---------------------------------------------------------------------------

function AllocateScreen(props: {
  targets: Target[];
  setTargets: (t: Target[]) => void;
  totalWeight: number;
  validation: ReturnType<typeof validateAllocation>;
  preference: Preference;
  setPreference: (p: Preference) => void;
  ctx: Ctx | null;
  source: "replay" | "public";
  setSource: (s: "replay" | "public") => void;
  bar: number;
  setBar: (n: number) => void;
  seedBar: number;
  setSeedBar: (n: number) => void;
  onReview: () => void;
  busy: boolean;
}) {
  const { targets, setTargets, totalWeight, validation, ctx } = props;
  const [phrase, setPhrase] = useState("");
  const [resolving, setResolving] = useState(false);
  const [pending, setPending] = useState<{ phrase: string; res: BasketResolution } | null>(null);

  function setWeight(i: number, pctValue: number) {
    const next = [...targets];
    next[i] = { ...next[i], weight: pctValue / 100 };
    setTargets(next);
  }

  async function resolve() {
    if (!phrase.trim()) return;
    setResolving(true);
    try {
      const res = await fetch("/api/basket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase }),
      });
      setPending({ phrase, res: (await res.json()) as BasketResolution });
    } finally {
      setResolving(false);
    }
  }

  function acceptBasket() {
    if (!pending || pending.res.members.length === 0) return;
    setTargets([
      ...targets,
      {
        kind: "basket",
        label: pending.phrase,
        weight: 0,
        members: pending.res.members,
        // Pinned at approval — it will not silently re-resolve later (§7.3).
        resolvedAt: new Date().toISOString(),
        rationale: pending.res.rationale,
      },
    ]);
    setPending(null);
    setPhrase("");
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <section className="rounded-2xl border bg-panel p-6">
          <h2 className="font-semibold">Target allocation</h2>
          <p className="mt-1 text-sm text-mut">
            Declare it once. Weights must total 100%.
          </p>

          <div className="mt-5 space-y-2">
            {targets.map((t, i) => (
              <div key={i} className="rounded-xl border bg-panel-2 p-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="font-medium">
                      {t.kind === "asset" ? t.symbol : t.label}
                      {t.kind === "basket" && (
                        <span className="ml-2 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-mut">
                          basket · pinned
                        </span>
                      )}
                    </div>
                    {t.kind === "basket" && (
                      <div className="mt-1 text-xs text-mut">
                        {t.members.map((m) => `${m.symbol} ${pct(m.weight * 100, 0)}`).join(" · ")}
                      </div>
                    )}
                  </div>
                  <input
                    type="number"
                    value={Number((t.weight * 100).toFixed(2))}
                    onChange={(e) => setWeight(i, Number(e.target.value))}
                    className="tnum w-20 rounded-lg border bg-panel px-2 py-1.5 text-right"
                    step={1}
                    min={0}
                    max={100}
                  />
                  <span className="text-sm text-mut">%</span>
                  <button
                    onClick={() => setTargets(targets.filter((_, j) => j !== i))}
                    className="rounded-lg border px-2 py-1 text-xs text-mut"
                  >
                    remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between border-t pt-4">
            <span className="text-sm text-mut">Total</span>
            <span
              className="tnum text-lg font-semibold"
              style={{
                color:
                  Math.abs(totalWeight - 1) < 1e-6 ? "var(--color-buy)" : "var(--color-sell)",
              }}
            >
              {pct(totalWeight * 100, 2)}
            </span>
          </div>

          {!validation.ok && (
            <ul className="mt-3 space-y-1 text-xs" style={{ color: "var(--color-sell)" }}>
              {validation.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border bg-panel p-6">
          <h2 className="font-semibold">Add a category</h2>
          <p className="mt-1 text-sm text-mut">
            Type it the way you think about it — &ldquo;L1s&rdquo;, &ldquo;AI tokens&rdquo;,
            &ldquo;DeFi blue chips&rdquo;. The agent resolves it to tradable symbols and defends the
            choice. You review and edit before it is saved; once approved it is pinned and never
            re-resolves on its own.
          </p>

          <div className="mt-4 flex gap-2">
            <input
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && resolve()}
              placeholder="AI tokens"
              className="flex-1 rounded-lg border bg-panel-2 px-3 py-2"
            />
            <button
              onClick={resolve}
              disabled={resolving || !phrase.trim() || !ctx?.llmAvailable}
              className="rounded-lg border px-4 py-2 text-sm disabled:opacity-40"
            >
              {resolving ? "Resolving…" : "Resolve"}
            </button>
          </div>
          {!ctx?.llmAvailable && (
            <p className="mt-2 text-xs" style={{ color: "var(--color-accent)" }}>
              Set ANTHROPIC_API_KEY to enable category resolution. Everything else works without it.
            </p>
          )}

          {pending && (
            <div className="mt-4 rounded-xl border bg-panel-2 p-4">
              <div className="flex items-center gap-2">
                <span className="font-medium">{pending.phrase}</span>
                <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-mut">
                  {pending.res.confidence} confidence
                </span>
              </div>
              <p className="mt-2 text-sm text-mut">{pending.res.rationale}</p>

              {pending.res.members.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {pending.res.members.map((m, i) => (
                    <div key={m.symbol} className="flex items-center gap-3 text-sm">
                      <span className="w-16 font-medium">{m.symbol}</span>
                      <input
                        type="number"
                        value={Number((m.weight * 100).toFixed(1))}
                        onChange={(e) => {
                          const members = [...pending.res.members];
                          members[i] = { ...members[i], weight: Number(e.target.value) / 100 };
                          setPending({ ...pending, res: { ...pending.res, members } });
                        }}
                        className="tnum w-16 rounded border bg-panel px-2 py-1 text-right"
                      />
                      <span className="text-mut">%</span>
                      <span className="flex-1 text-xs text-mut">{m.why}</span>
                      <button
                        onClick={() =>
                          setPending({
                            ...pending,
                            res: {
                              ...pending.res,
                              members: pending.res.members.filter((_, j) => j !== i),
                            },
                          })
                        }
                        className="text-xs text-mut"
                      >
                        remove
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {pending.res.excluded.length > 0 && (
                <div className="mt-3 border-t pt-3 text-xs text-mut">
                  <span className="font-medium">Deliberately excluded: </span>
                  {pending.res.excluded.map((e) => `${e.symbol} (${e.why})`).join(" · ")}
                </div>
              )}

              <div className="mt-4 flex gap-2">
                <button
                  onClick={acceptBasket}
                  disabled={pending.res.members.length === 0}
                  className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-40"
                  style={{ background: "var(--color-accent)", color: "var(--color-ink)" }}
                >
                  Add basket at 0% — set its weight above
                </button>
                <button onClick={() => setPending(null)} className="rounded-lg border px-4 py-2 text-sm">
                  Discard
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      <div className="space-y-6">
        <section className="rounded-2xl border bg-panel p-6">
          <h2 className="font-semibold">How closely to track</h2>
          <div className="mt-3 space-y-2">
            {(["patient", "balanced", "tight"] as Preference[]).map((p) => (
              <button
                key={p}
                onClick={() => props.setPreference(p)}
                className="w-full rounded-lg border px-3 py-2 text-left text-sm capitalize"
                style={{
                  background: props.preference === p ? "var(--color-panel-2)" : "transparent",
                }}
              >
                {p}
                <span className="ml-2 text-xs text-mut">
                  {p === "patient"
                    ? "act rarely, weight cost heavily"
                    : p === "tight"
                      ? "track closely, accept higher cost"
                      : "the default trade-off"}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border bg-panel p-6">
          <h2 className="font-semibold">Data source</h2>
          <div className="mt-3 space-y-2 text-sm">
            <button
              onClick={() => props.setSource("replay")}
              disabled={!ctx?.replay}
              className="w-full rounded-lg border px-3 py-2 text-left disabled:opacity-40"
              style={{ background: props.source === "replay" ? "var(--color-panel-2)" : "transparent" }}
            >
              Replay
              <span className="ml-2 text-xs text-mut">
                {ctx?.replay
                  ? `${ctx.replay.symbols.join(", ")} · ${ctx.replay.bars} bars`
                  : "no dataset — run npm run klines"}
              </span>
            </button>
            <button
              onClick={() => props.setSource("public")}
              className="w-full rounded-lg border px-3 py-2 text-left"
              style={{ background: props.source === "public" ? "var(--color-panel-2)" : "transparent" }}
            >
              Live public market data
              <span className="ml-2 text-xs text-mut">real depth; enter holdings yourself</span>
            </button>
          </div>

          {props.source === "replay" && ctx?.replay && (
            <div className="mt-4 space-y-3 border-t pt-4">
              <label className="block text-xs text-mut">
                Bought the target allocation at bar {props.seedBar}
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, ctx.replay.bars - 2)}
                  value={props.seedBar}
                  onChange={(e) => props.setSeedBar(Number(e.target.value))}
                  className="mt-1 w-full"
                />
              </label>
              <label className="block text-xs text-mut">
                Reviewing at bar {props.bar} ({Math.round((props.bar - props.seedBar) / 24)} days
                later)
                <input
                  type="range"
                  min={0}
                  max={ctx.replay.bars - 1}
                  value={props.bar}
                  onChange={(e) => props.setBar(Number(e.target.value))}
                  className="mt-1 w-full"
                />
              </label>
              <p className="text-[11px] leading-relaxed text-mut">
                The portfolio is bought on target and then left alone. Drift is produced by the
                market moving under it — exactly as it would in life.
              </p>
            </div>
          )}
        </section>

        <button
          onClick={props.onReview}
          disabled={props.busy || !validation.ok}
          className="w-full rounded-xl px-5 py-3 font-semibold disabled:opacity-40"
          style={{ background: "var(--color-accent)", color: "var(--color-ink)" }}
        >
          {props.busy ? "Reviewing…" : "Review my portfolio"}
        </button>
      </div>
    </div>
  );
}
