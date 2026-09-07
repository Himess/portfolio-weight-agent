"use client";

/**
 * Asking about the plan you are looking at.
 *
 * The command box on the allocate screen can already answer a question, and
 * that is the wrong place to be standing when you have one. The moment someone
 * wants to ask "why not SOL?" is the moment the plan is in front of them — by
 * the time they have clicked back two screens, the question is about a decision
 * they can no longer see.
 *
 * So this is the same answer on the screen it belongs to, with two differences
 * that matter. It routes nothing: every sentence here is a question about this
 * decision, so there is no chance of editing a portfolio while reading a plan.
 * And it offers the question worth asking — the leg the agent declined, which
 * is exactly the one a threshold rule would have traded.
 */

import { useEffect, useRef, useState } from "react";

import { explainFactsFrom } from "@/lib/explain-facts";
import type { Proposal } from "@/types";

type Turn = { role: "you" | "agent"; text: string; pending?: boolean };

/**
 * What is worth asking about this particular plan, in priority order: a leg it
 * declined, then a sale (the psychologically hard half), then the cost.
 */
function suggestions(p: Proposal): string[] {
  const out: string[] = [];
  const left = p.declined[0]?.symbol;
  if (left) out.push(`why didn’t you trade ${left}?`);
  if (p.timing.action === "HOLD") out.push("why nothing at all?");
  const sold = p.orderedTrades.find((t) => t.side === "SELL")?.symbol;
  if (sold) out.push(`why sell ${sold}?`);
  out.push("what is this costing me?");
  return out.slice(0, 3);
}

export function Ask({ proposal, available }: { proposal: Proposal; available: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns]);

  async function send(question: string) {
    if (!question.trim() || busy) return;
    setDraft("");
    setTurns((t) => [...t, { role: "you", text: question }, { role: "agent", text: "", pending: true }]);
    setBusy(true);
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, facts: explainFactsFrom(proposal) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "That did not work.");
      setTurns((t) => [...t.slice(0, -1), { role: "agent", text: json.say ?? "" }]);
    } catch (err) {
      setTurns((t) => [
        ...t.slice(0, -1),
        { role: "agent", text: err instanceof Error ? err.message : "That did not work." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  const hints = suggestions(proposal);

  return (
    <div className="card" style={{ padding: "20px 22px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Ask about this decision</h2>
        <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
          answered from the facts it was made on
        </span>
      </div>

      {!available ? (
        <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: "10px 0 0", lineHeight: 1.6 }}>
          No judgment provider is configured, so questions are off. Every figure on this page is
          computed either way.
        </p>
      ) : (
        <>
          {turns.length > 0 && (
            <div
              className="scroll"
              style={{ display: "flex", flexDirection: "column", gap: 10, margin: "14px 0 0", maxHeight: 300 }}
            >
              {turns.map((t, i) => (
                <div key={i} style={{ display: "flex", justifyContent: t.role === "you" ? "flex-end" : "flex-start" }}>
                  <div
                    style={{
                      maxWidth: "88%",
                      padding: "9px 12px",
                      borderRadius: "var(--r-sm)",
                      background: t.role === "you" ? "var(--ink)" : "var(--surface-2)",
                      color: t.role === "you" ? "var(--surface)" : "var(--ink)",
                      border: t.role === "you" ? "none" : "1px solid var(--line)",
                      fontSize: 12.5,
                      lineHeight: 1.55,
                    }}
                  >
                    {t.pending ? <span style={{ color: "var(--ink-3)" }}>thinking…</span> : t.text}
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
            style={{ display: "flex", gap: 8, marginTop: 14 }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={hints[0]}
              maxLength={400}
              aria-label="Question about this decision"
              style={{
                flex: 1,
                minWidth: 0,
                padding: "10px 12px",
                borderRadius: "var(--r-sm)",
                border: "1px solid var(--line-2)",
                background: "var(--surface-2)",
                fontSize: 13,
                outline: "none",
              }}
            />
            <button className="btn btn-primary" disabled={busy || draft.trim().length === 0}>
              {busy ? "…" : "Ask"}
            </button>
          </form>

          {turns.length === 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
              {hints.map((q) => (
                <button
                  key={q}
                  onClick={() => void send(q)}
                  className="pill pill-quiet"
                  style={{ cursor: "pointer", border: "1px solid var(--line)", background: "transparent" }}
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "12px 0 0", lineHeight: 1.6 }}>
            It answers from the fact sheet this verdict was made on, not from a fresh look at the
            market — so the reason you get is the reason the decision had. It cannot change the plan
            or place an order.
          </p>
        </>
      )}
    </div>
  );
}
