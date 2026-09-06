"use client";

/**
 * Four screens (DESIGN.md §10). Three of them carry the product:
 * portfolio, proposal, and the HOLD state. Allocate is functional.
 */

import { useEffect, useMemo, useState } from "react";

import { Portfolio } from "./components/Portfolio";
import { Handoff, ProposalView } from "./components/Proposal";
import { McpPanel } from "./components/McpPanel";
import { TokenPicker } from "./components/TokenPicker";
import { Swatch } from "./components/ui";
import { validateAllocation } from "@/core/allocation";
import { clear as clearSaved, load as loadSaved, save as saveState } from "@/lib/persist";
import { daysSinceLastRebalance, markApproved, record as recordDecision, summary as historySummary } from "@/lib/history";
import { pct } from "@/lib/format";
import type { Allocation, BasketResolution, Preference, Proposal, Target } from "@/types";

type Screen = "allocate" | "portfolio" | "proposal" | "handoff";
const SCREENS: Screen[] = ["allocate", "portfolio", "proposal", "handoff"];

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
  const cashSymbol = "USDT";
  const [preference, setPreference] = useState<Preference>("balanced");
  const [ctx, setCtx] = useState<Ctx | null>(null);

  const [source, setSource] = useState<"replay" | "public">("replay");
  const [bar, setBar] = useState(8484);
  const [seedBar, setSeedBar] = useState(30);
  const [holdings, setHoldings] = useState<{ symbol: string; qty: string }[]>([
    { symbol: "BTC", qty: "0.25" },
    { symbol: "ETH", qty: "5" },
    { symbol: "SOL", qty: "70" },
    { symbol: "AVAX", qty: "400" },
    { symbol: "USDT", qty: "6000" },
  ]);

  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const [lastEntryAt, setLastEntryAt] = useState<string | null>(null);
  const [history, setHistory] = useState<{ total: number; holds: number; approved: number }>({
    total: 0,
    holds: 0,
    approved: 0,
  });
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [series, setSeries] = useState<Record<string, number[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore before the first paint of the allocation screen. Runs once.
  useEffect(() => {
    const saved = loadSaved();
    if (saved) {
      setTargets(saved.allocation.targets);
      setPreference(saved.preference);
      setRestoredAt(saved.savedAt);
    }
    setHistory(historySummary());
  }, []);

  useEffect(() => {
    fetch("/api/context")
      .then((r) => r.json())
      .then((c: Ctx) => {
        setCtx(c);
        if (!c.replay) setSource("public");
      })
      .catch(() => setError("Could not load context."));
  }, []);

  const allocation: Allocation = useMemo(() => ({ targets, cashSymbol }), [targets]);
  const validation = useMemo(() => validateAllocation(allocation), [allocation]);

  // Persist whatever the user has built. Only valid allocations are written, so
  // a half-edited state cannot be restored into a broken one later.
  useEffect(() => {
    if (validation.ok) saveState(allocation, preference);
  }, [allocation, preference, validation.ok]);
  const totalWeight = targets.reduce((a, t) => a + t.weight, 0);
  const onTarget = Math.abs(totalWeight - 1) < 1e-6;

  async function review() {
    setBusy(true);
    setError(null);

    // A review makes several upstream calls, some to a rate-limited free tier.
    // Without a ceiling the UI sits on "Reviewing…" indefinitely and the user
    // cannot tell a slow answer from a dead one.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);

    try {
      const res = await fetch("/api/review", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allocation,
          preference,
          source,
          bar,
          seedBar: source === "replay" ? seedBar : undefined,
          seedNavUsd: 100_000,
          quantities:
            source === "public"
              ? Object.fromEntries(
                  holdings
                    .filter((h) => h.symbol.trim() && Number(h.qty) > 0)
                    .map((h) => [h.symbol.trim().toUpperCase(), Number(h.qty)]),
                )
              : undefined,
          // Live runs read staleness from the decision log, so the agent's
          // "you have not rebalanced in N days" is about this user, not a
          // replay bar index.
          daysSinceLastRebalance:
            source === "replay" ? Math.round((bar - seedBar) / 24) : daysSinceLastRebalance(),
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(explain(json.error, res.status));

      const p = json.proposal as Proposal;
      setProposal(p);
      setSeries((json.series as Record<string, number[]>) ?? {});

      const entry = recordDecision({
        action: p.timing.action,
        primaryFactor: p.timing.primaryFactor,
        driftPp: p.context.portfolio.totalDriftPp,
        navUsd: p.context.portfolio.navUsd,
        proposed: p.orderedTrades.length,
        approved: false,
        fellBack: Boolean(p.timing.fellBack),
        reasoning: p.timing.reasoning,
      });
      setLastEntryAt(entry.at);
      setHistory(historySummary());

      setScreen("portfolio");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setError(
          "The review took longer than 90 seconds and was stopped. Nothing was sent. " +
            "If your provider is on a free tier it may be rate-limited — wait a minute and try again.",
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  }

  const reached = (s: Screen): boolean => {
    if (s === "allocate") return true;
    if (!proposal) return false;
    if (s === "handoff") return proposal.orderedTrades.length > 0;
    return true;
  };
  const done = (s: Screen): boolean => SCREENS.indexOf(s) < SCREENS.indexOf(screen) && reached(s);

  return (
    <main style={{ maxWidth: 1240, margin: "0 auto", padding: "34px 26px 60px" }}>
      <header style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ fontSize: 21, fontWeight: 800, margin: 0, letterSpacing: "-0.02em" }}>
              Portfolio Weight Agent
            </h1>
            <p style={{ fontSize: 13.5, color: "var(--ink-2)", margin: "6px 0 0", maxWidth: "62ch", lineHeight: 1.5 }}>
              Selling your winners and buying your losers is psychologically hard. The agent proposes
              it; you approve it.
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7, alignItems: "flex-end" }}>
            <span className={ctx?.llmAvailable ? "pill pill-green" : "pill pill-accent"}>
              <Dot on={Boolean(ctx?.llmAvailable)} />
              {ctx ? (ctx.llmAvailable ? ctx.model : "no provider — deterministic fallback") : "…"}
            </span>
            <span className="pill pill-quiet">math: deterministic, always</span>
          </div>
        </div>

        {/* progress: completed steps are ticked, not just highlighted */}
        <nav style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 22, flexWrap: "wrap" }}>
          {SCREENS.map((s, i) => {
            const active = screen === s;
            const complete = done(s);
            return (
              <span key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {i > 0 && <span style={{ width: 16, height: 1, background: "var(--line-2)" }} />}
                <button
                  disabled={!reached(s)}
                  onClick={() => setScreen(s)}
                  className="chip"
                  data-on={active ? 1 : 0}
                  style={{
                    padding: "7px 14px",
                    fontSize: 12.5,
                    opacity: reached(s) ? 1 : 0.4,
                    cursor: reached(s) ? "pointer" : "not-allowed",
                    borderColor: complete && !active ? "var(--green-line)" : undefined,
                    background: complete && !active ? "var(--green-bg)" : undefined,
                    color: complete && !active ? "var(--green-ink)" : undefined,
                    textTransform: "capitalize",
                  }}
                >
                  {complete && !active ? "✓" : i + 1}. {s}
                </button>
              </span>
            );
          })}
        </nav>
      </header>

      {error && (
        <div
          className="card card-p"
          style={{ borderColor: "var(--red-line)", background: "var(--red-bg)", color: "var(--red)", marginBottom: 18, fontSize: 13.5 }}
        >
          {error}
        </div>
      )}

      {screen === "allocate" && (
        <Allocate
          targets={targets}
          setTargets={setTargets}
          totalWeight={totalWeight}
          onTarget={onTarget}
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
          holdings={holdings}
          setHoldings={setHoldings}
          onReview={review}
          busy={busy}
          restoredAt={restoredAt}
          history={history}
          onReset={() => {
            clearSaved();
            setTargets(DEFAULT_TARGETS);
            setPreference("balanced");
            setRestoredAt(null);
          }}
        />
      )}

      {screen === "portfolio" && proposal && (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <Portfolio state={proposal.context.portfolio} cashSymbol={cashSymbol} series={series} />
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button className="btn btn-primary" onClick={() => setScreen("proposal")}>
              See what the agent decided
            </button>
            <button className="btn" onClick={review} disabled={busy}>
              {busy ? "Reviewing…" : "Re-run review"}
            </button>
          </div>
        </div>
      )}

      {screen === "proposal" && proposal && (
        <ProposalView
          proposal={proposal}
          onApprove={() => {
            // Only an approval resets the staleness clock; a dismissed
            // proposal rebalanced nothing.
            if (lastEntryAt) markApproved(lastEntryAt);
            setHistory(historySummary());
            setScreen("handoff");
          }}
          onDismiss={() => setScreen("portfolio")}
        />
      )}

      {screen === "handoff" && proposal && <Handoff proposal={proposal} onBack={() => setScreen("proposal")} />}

      <footer style={{ marginTop: 44, paddingTop: 20, borderTop: "1px solid var(--line)", fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.65, maxWidth: "84ch" }}>
        Not investment advice. You are the decision-maker: every order requires your confirmation in
        Binance before it executes. The agent chooses and explains; every quantity, price and
        percentage on this page is computed by deterministic code, never by the model.
      </footer>
    </main>
  );
}

/** Upstream errors are for operators; this turns them into a next action. */
function explain(message: unknown, status: number): string {
  const text = typeof message === "string" ? message : "Review failed.";
  if (/rate limit|429|quota/i.test(text)) {
    return (
      "The model provider is rate-limited right now — free tiers cap requests per minute and per day. " +
      "Wait a minute and try again, or switch provider in .env. Nothing was sent."
    );
  }
  if (/no LLM provider/i.test(text)) {
    return (
      "No model provider is configured, so the agent cannot form a judgment. " +
      "The deterministic band rule still works — add a key to .env to enable the rest."
    );
  }
  if (status === 400) return text;
  return `${text} Nothing was sent to Binance.`;
}

function Dot({ on }: { on: boolean }) {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        background: on ? "var(--green)" : "var(--amber)",
        display: "inline-block",
        flex: "none",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Screen 1 — Allocate
// ---------------------------------------------------------------------------

function Allocate(props: {
  targets: Target[];
  setTargets: (t: Target[]) => void;
  totalWeight: number;
  onTarget: boolean;
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
  holdings: { symbol: string; qty: string }[];
  setHoldings: (h: { symbol: string; qty: string }[]) => void;
  onReview: () => void;
  busy: boolean;
  restoredAt: string | null;
  history: { total: number; holds: number; approved: number };
  onReset: () => void;
}) {
  const { targets, setTargets, totalWeight, onTarget, validation, ctx } = props;
  // Every symbol the allocation already refers to, basket members included.
  const heldSymbols = useMemo(() => {
    const out = new Set<string>();
    for (const t of targets) {
      if (t.kind === "asset") out.add(t.symbol);
      else for (const m of t.members) out.add(m.symbol);
    }
    return out;
  }, [targets]);
  const [phrase, setPhrase] = useState("");
  const [resolving, setResolving] = useState(false);
  const [pending, setPending] = useState<{ phrase: string; res: BasketResolution } | null>(null);

  function setWeight(i: number, v: number) {
    const next = [...targets];
    next[i] = { ...next[i], weight: v / 100 };
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

  return (
    <div className="split split-main">
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div className="card card-p">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Target allocation</h2>
              <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "5px 0 0" }}>
                Declare it once. Weights must total 100%.
              </p>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="m" style={{ fontSize: 22, fontWeight: 700, color: onTarget ? "var(--green)" : "var(--amber)" }}>
                {pct(totalWeight * 100, 1)}
              </div>
              <div className="lbl">{onTarget ? "allocated" : `${(100 - totalWeight * 100).toFixed(1)}pp to place`}</div>
            </div>
          </div>

          {props.restoredAt && (
            // Say why they are looking at something other than the defaults,
            // and make it one click to get back to them.
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 12,
                padding: "8px 12px",
                borderRadius: "var(--r-sm)",
                background: "var(--surface-2)",
                border: "1px solid var(--line)",
                fontSize: 11.5,
                color: "var(--ink-2)",
              }}
            >
              <span style={{ flex: 1 }}>
                Restored your allocation from{" "}
                {new Date(props.restoredAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                . Saved in this browser only.
              </span>
              <button className="btn-link" onClick={props.onReset}>
                start over
              </button>
            </div>
          )}

          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            {targets.map((t, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 14px",
                  borderRadius: "var(--r-inner)",
                  border: "1px solid var(--line)",
                  background: t.kind === "basket" ? "var(--accent-soft)" : "var(--surface-2)",
                  borderColor: t.kind === "basket" ? "var(--accent-line)" : "var(--line)",
                }}
              >
                <Swatch i={i} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>
                      {t.kind === "asset" ? t.symbol : t.label}
                    </span>
                    {t.kind === "basket" && (
                      <>
                        <span className="pill pill-accent" style={{ padding: "2px 8px", fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 700 }}>
                          basket · pinned
                        </span>
                        <span style={{ fontSize: 11, color: "var(--accent-ink)" }}>
                          {t.members.length} assets, resolved once and frozen
                        </span>
                      </>
                    )}
                  </div>
                  {t.kind === "basket" && (
                    <div className="m" style={{ fontSize: 11.5, color: "var(--ink-2)", marginTop: 5 }}>
                      {t.members.map((m) => `${m.symbol} ${(m.weight * 100).toFixed(0)}%`).join("  ·  ")}
                    </div>
                  )}
                </div>
                <input
                  type="number"
                  value={Number((t.weight * 100).toFixed(2))}
                  onChange={(e) => setWeight(i, Number(e.target.value))}
                  className="m"
                  style={{
                    width: 66,
                    padding: "7px 9px",
                    textAlign: "right",
                    borderRadius: "var(--r-sm)",
                    border: "1px solid var(--line-2)",
                    background: "var(--surface)",
                    fontSize: 13,
                    outline: "none",
                  }}
                  step={1}
                  min={0}
                  max={100}
                />
                <span style={{ fontSize: 13, color: "var(--ink-3)" }}>%</span>
                <button className="btn-link" onClick={() => setTargets(targets.filter((_, j) => j !== i))}>
                  remove
                </button>
              </div>
            ))}
          </div>

          {!validation.ok && (
            <ul style={{ margin: "14px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--red)", lineHeight: 1.7 }}>
              {validation.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>

        <TokenPicker
          held={heldSymbols}
          onToggle={(sym) => {
            const isLeaf = targets.some((t) => t.kind === "asset" && t.symbol === sym);
            if (isLeaf) {
              setTargets(targets.filter((t) => !(t.kind === "asset" && t.symbol === sym)));
              return;
            }
            // A symbol inside a pinned basket is not a free-standing target;
            // removing it there would silently rewrite the basket.
            if (heldSymbols.has(sym)) return;
            setTargets([...targets, { kind: "asset", symbol: sym, weight: 0 }]);
          }}
        />

        <div className="card card-p">
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Add a category</h2>
          <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "5px 0 0", lineHeight: 1.55, maxWidth: "64ch" }}>
            Type it the way you think about it. The agent resolves it to tradable symbols and defends
            the choice — including what it deliberately left out. You edit before it is saved; once
            approved it is pinned and never re-resolves on its own.
          </p>

          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <div className="search" style={{ flex: 1 }}>
              <span style={{ color: "var(--ink-3)", fontSize: 13 }}>⌕</span>
              <input
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && resolve()}
                placeholder="AI tokens, DeFi blue chips, restaking…"
              />
            </div>
            <button className="btn" onClick={resolve} disabled={resolving || !phrase.trim() || !ctx?.llmAvailable}>
              {resolving ? "Resolving…" : "Resolve"}
            </button>
          </div>
          {!ctx?.llmAvailable && (
            <p style={{ fontSize: 11.5, color: "var(--amber)", marginTop: 9 }}>
              Needs an LLM provider. Everything else works without one.
            </p>
          )}

          {pending && (
            <div style={{ marginTop: 16, padding: 18, borderRadius: "var(--r-inner)", background: "var(--surface-2)", border: "1px solid var(--line)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, fontSize: 14.5 }}>{pending.phrase}</span>
                <span className={`pill ${pending.res.confidence === "high" ? "pill-green" : "pill-quiet"}`} style={{ padding: "3px 10px", fontSize: 11 }}>
                  {pending.res.confidence} confidence
                </span>
              </div>
              <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "9px 0 0", lineHeight: 1.55 }}>
                {pending.res.rationale}
              </p>

              {pending.res.members.map((m, i) => (
                <div key={m.symbol} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 9, fontSize: 13 }}>
                  <span style={{ fontWeight: 650, width: 58 }}>{m.symbol}</span>
                  <input
                    type="number"
                    value={Number((m.weight * 100).toFixed(1))}
                    onChange={(e) => {
                      const members = [...pending.res.members];
                      members[i] = { ...members[i], weight: Number(e.target.value) / 100 };
                      setPending({ ...pending, res: { ...pending.res, members } });
                    }}
                    className="m"
                    style={{ width: 58, padding: "5px 8px", textAlign: "right", borderRadius: 9, border: "1px solid var(--line-2)", background: "var(--surface)", outline: "none" }}
                  />
                  <span style={{ color: "var(--ink-3)" }}>%</span>
                  <span style={{ flex: 1, fontSize: 12, color: "var(--ink-2)" }}>{m.why}</span>
                  <button
                    className="btn-link"
                    onClick={() =>
                      setPending({ ...pending, res: { ...pending.res, members: pending.res.members.filter((_, j) => j !== i) } })
                    }
                  >
                    remove
                  </button>
                </div>
              ))}

              {pending.res.excluded.length > 0 && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)", fontSize: 12, color: "var(--ink-2)", lineHeight: 1.6 }}>
                  <span style={{ fontWeight: 650 }}>Deliberately excluded: </span>
                  {pending.res.excluded.map((e) => `${e.symbol} (${e.why})`).join(" · ")}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 15 }}>
                <button
                  className="btn btn-primary"
                  disabled={pending.res.members.length === 0}
                  onClick={() => {
                    setTargets([
                      ...targets,
                      {
                        kind: "basket",
                        label: pending.phrase,
                        weight: 0,
                        members: pending.res.members,
                        resolvedAt: new Date().toISOString(),
                        rationale: pending.res.rationale,
                      },
                    ]);
                    setPending(null);
                    setPhrase("");
                  }}
                >
                  Add basket — then set its weight
                </button>
                <button className="btn" onClick={() => setPending(null)}>
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <McpPanel />

        <div className="card card-p">
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>How closely to track</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 12 }}>
            {(["patient", "balanced", "tight"] as Preference[]).map((p) => (
              <button
                key={p}
                onClick={() => props.setPreference(p)}
                className="btn"
                style={{
                  justifyContent: "flex-start",
                  borderRadius: "var(--r-sm)",
                  background: props.preference === p ? "var(--ink)" : "var(--surface)",
                  color: props.preference === p ? "var(--surface)" : "var(--ink)",
                  borderColor: props.preference === p ? "var(--ink)" : "var(--line-2)",
                  textAlign: "left",
                }}
              >
                <span style={{ fontWeight: 700, textTransform: "capitalize", minWidth: 62 }}>{p}</span>
                <span style={{ fontSize: 11.5, opacity: 0.75, fontWeight: 500 }}>
                  {p === "patient" ? "act rarely, weight cost heavily" : p === "tight" ? "track closely, accept higher cost" : "the default trade-off"}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="card card-p">
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Data source</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 12 }}>
            <SourceBtn
              on={props.source === "replay"}
              disabled={!ctx?.replay}
              onClick={() => props.setSource("replay")}
              title="Replay"
              note={ctx?.replay ? `${ctx.replay.symbols.join(", ")} · ${ctx.replay.bars} bars` : "no dataset — npm run klines"}
            />
            <SourceBtn
              on={props.source === "public"}
              onClick={() => props.setSource("public")}
              title="Live public market data"
              note="real depth; enter holdings yourself"
            />
          </div>

          {props.source === "replay" && ctx?.replay && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 12 }}>
              <Slider label={`Bought on target at bar ${props.seedBar}`} max={Math.max(0, ctx.replay.bars - 2)} value={props.seedBar} onChange={props.setSeedBar} />
              <Slider
                label={`Reviewing at bar ${props.bar} · ${Math.round((props.bar - props.seedBar) / 24)} days later`}
                max={ctx.replay.bars - 1}
                value={props.bar}
                onChange={props.setBar}
              />
              <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.6 }}>
                Bought on target, then left alone. Drift comes from the market moving under it.
                Bar 393 is a captured HOLD.
              </p>
            </div>
          )}

          {props.source === "public" && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
              <div className="lbl" style={{ marginBottom: 9 }}>
                Your holdings
              </div>
              {props.holdings.map((h, i) => (
                <div key={i} style={{ display: "flex", gap: 7, marginBottom: 7 }}>
                  <input
                    value={h.symbol}
                    onChange={(e) => {
                      const next = [...props.holdings];
                      next[i] = { ...next[i], symbol: e.target.value.toUpperCase() };
                      props.setHoldings(next);
                    }}
                    style={{ width: 72, padding: "6px 9px", borderRadius: 9, border: "1px solid var(--line-2)", background: "var(--surface-2)", fontSize: 12.5, fontWeight: 600, outline: "none" }}
                  />
                  <input
                    value={h.qty}
                    onChange={(e) => {
                      const next = [...props.holdings];
                      next[i] = { ...next[i], qty: e.target.value };
                      props.setHoldings(next);
                    }}
                    className="m"
                    style={{ flex: 1, padding: "6px 9px", textAlign: "right", borderRadius: 9, border: "1px solid var(--line-2)", background: "var(--surface-2)", fontSize: 12.5, outline: "none" }}
                  />
                  <button className="btn-link" onClick={() => props.setHoldings(props.holdings.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </div>
              ))}
              <button className="btn" style={{ width: "100%", padding: "7px 0", fontSize: 12 }} onClick={() => props.setHoldings([...props.holdings, { symbol: "", qty: "0" }])}>
                Add holding
              </button>
            </div>
          )}
        </div>

        {props.history.total > 0 && (
          <div className="card card-p">
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>What the agent has done</h2>
            <div style={{ display: "flex", gap: 18, marginTop: 12 }}>
              {[
                { n: props.history.total, l: "reviews" },
                { n: props.history.holds, l: "held" },
                { n: props.history.approved, l: "approved" },
              ].map((x) => (
                <div key={x.l}>
                  <div className="m" style={{ fontSize: 19, fontWeight: 700 }}>
                    {x.n}
                  </div>
                  <div className="lbl">{x.l}</div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "10px 0 0", lineHeight: 1.5 }}>
              Only an approved rebalance resets the clock the agent reads for staleness — a proposal
              you dismissed rebalanced nothing.
            </p>
          </div>
        )}

        <button
          className="btn btn-primary"
          style={{ width: "100%", padding: "15px 0", fontSize: 14.5 }}
          onClick={props.onReview}
          disabled={props.busy || !validation.ok}
          title={validation.ok ? undefined : validation.errors.join(" ")}
        >
          {props.busy ? "Reviewing…" : "Review my portfolio"}
        </button>
        {!validation.ok && (
          // Show the actual blocker. "Weights must total 100%" is wrong and
          // confusing when the total already reads 100% and the real problem is
          // a newly-added asset still sitting at zero.
          <p style={{ fontSize: 11.5, color: "var(--amber)", margin: "-8px 0 0", textAlign: "center", lineHeight: 1.5 }}>
            {validation.errors[0]}
            {validation.errors.length > 1 && ` (+${validation.errors.length - 1} more)`}
          </p>
        )}
      </div>
    </div>
  );
}

function SourceBtn({ on, disabled, onClick, title, note }: { on: boolean; disabled?: boolean; onClick: () => void; title: string; note: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="btn"
      style={{
        justifyContent: "flex-start",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 3,
        borderRadius: "var(--r-sm)",
        padding: "10px 14px",
        background: on ? "var(--ink)" : "var(--surface)",
        color: on ? "var(--surface)" : "var(--ink)",
        borderColor: on ? "var(--ink)" : "var(--line-2)",
      }}
    >
      <span style={{ fontWeight: 700, fontSize: 13 }}>{title}</span>
      <span style={{ fontSize: 11, opacity: 0.75, fontWeight: 500 }}>{note}</span>
    </button>
  );
}

function Slider({ label, max, value, onChange }: { label: string; max: number; value: number; onChange: (n: number) => void }) {
  return (
    <label style={{ display: "block", fontSize: 11.5, color: "var(--ink-2)" }}>
      {label}
      <input type="range" min={0} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: "100%", marginTop: 6, accentColor: "var(--ink)" }} />
    </label>
  );
}
