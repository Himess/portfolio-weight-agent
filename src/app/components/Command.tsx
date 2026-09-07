"use client";

/**
 * Talking to the agent.
 *
 * The rest of the app is a form: click a token, type a percentage, pick a
 * tracking setting. That is fine once you know what you want, and slow when you
 * already do — "BTC 40, add SUI at 10, track tighter" is one sentence and four
 * controls.
 *
 * Two rules make this safe to look at.
 *
 * The reply is split in two. The agent's sentence is prose and is treated as
 * prose. What actually changed is rendered underneath from the deterministic
 * result — "BTC 40% → 50%" appears because `applyEdits` did that, not because
 * the model said so. If the two ever disagree, the chips are right.
 *
 * And there is no instruction that trades. Asking it to sell something returns
 * "unsupported" with a sentence saying approval happens in Binance.
 */

import { useEffect, useRef, useState } from "react";

import { explainFactsFrom } from "@/lib/explain-facts";
import type { Allocation, Preference, Proposal, Target } from "@/types";

type Turn = {
  role: "you" | "agent";
  text: string;
  /** Deterministic descriptions of what changed, if anything did. */
  changes?: string[];
  rejected?: string[];
  /** Set when the allocation no longer sums to 100 after the edit. */
  warning?: string | null;
  pending?: boolean;
};

const EDIT_EXAMPLES = [
  "make BTC 40 and add SUI at 10",
  "track more closely",
  "add a basket of AI tokens at 15%",
];

/**
 * The fourth suggestion is the question the agent can now answer, aimed at
 * whichever position makes it interesting: one it declined, else one it traded.
 * A static "why didn’t you sell AVAX?" is a bad prompt on a portfolio with no
 * AVAX in it, and worse on one where AVAX was sold.
 */
function examplesFor(proposal: Proposal | null): string[] {
  if (!proposal) return EDIT_EXAMPLES;
  const left = proposal.declined[0]?.symbol;
  if (left) return [...EDIT_EXAMPLES, `why didn’t you trade ${left}?`];
  const sold = proposal.orderedTrades.find((t) => t.side === "SELL")?.symbol;
  if (sold) return [...EDIT_EXAMPLES, `why sell ${sold}?`];
  return [...EDIT_EXAMPLES, "why that verdict?"];
}

export function Command({
  allocation,
  preference,
  hasProposal,
  proposal,
  onTargets,
  onPreference,
  onBasket,
  onReview,
  available,
}: {
  allocation: Allocation;
  preference: Preference;
  hasProposal: boolean;
  /** The last decision, so a question about it can be answered from its facts. */
  proposal: Proposal | null;
  onTargets: (t: Target[]) => void;
  onPreference: (p: Preference) => void;
  onBasket: (phrase: string, weightPct: number | null) => void;
  onReview: () => void;
  /** False with no judgment provider — the box explains instead of failing. */
  available: boolean;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns]);

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setDraft("");
    setTurns((t) => [...t, { role: "you", text: message }, { role: "agent", text: "", pending: true }]);
    setBusy(true);

    try {
      const res = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          allocation,
          preference,
          hasProposal,
          // Only the fields an answer may quote. The router decides whether
          // the question was one about the decision at all.
          facts: proposal ? explainFactsFrom(proposal) : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "That did not work.");

      const turn: Turn = { role: "agent", text: json.say ?? "" };

      // Applied for any intent that carried one, not just set_preference — a
      // single sentence can change weights and tracking together.
      if (json.preference) {
        onPreference(json.preference as Preference);
        turn.changes = [`Tracking set to ${json.preference}`];
      }

      if (json.intent === "edit" && Array.isArray(json.targets)) {
        onTargets(json.targets as Target[]);
        const changes: string[] = [...(turn.changes ?? []), ...(json.changes ?? [])];
        const rejected: string[] = json.rejected ?? [];
        turn.changes = changes;
        turn.rejected = rejected;
        // An edit that changed nothing is a real outcome and has to be said.
        // Silence reads as a failure, and the model's acknowledgement cannot be
        // trusted to know — it never sees the result.
        if (changes.length === 0 && rejected.length === 0 && !json.preference) {
          turn.text = "Nothing to change — that is already the allocation.";
        }
        // The server's own validator says what is wrong; restating it as a
        // total was wrong whenever the total was fine.
        if (json.valid === false) turn.warning = json.problem ?? "That allocation will not validate.";
      } else if (json.intent === "add_basket" && json.phrase) {
        onBasket(json.phrase as string, json.weightPct ?? null);
        turn.changes = [`Resolving "${json.phrase}"`];
      } else if (json.intent === "review") {
        onReview();
      }

      setTurns((t) => [...t.slice(0, -1), turn]);
    } catch (err) {
      setTurns((t) => [
        ...t.slice(0, -1),
        { role: "agent", text: err instanceof Error ? err.message : String(err) },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: "20px 22px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Tell the agent</h2>
        <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
          it edits the allocation; it cannot trade
        </span>
      </div>

      {!available ? (
        <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: "10px 0 0", lineHeight: 1.6 }}>
          No judgment provider is configured, so typed instructions are off. Every control below
          still works.
        </p>
      ) : (
        <>
          {turns.length > 0 && (
            <div
              className="scroll"
              style={{ display: "flex", flexDirection: "column", gap: 10, margin: "14px 0 0", maxHeight: 300 }}
            >
              {turns.map((t, i) => (
                <Bubble key={i} turn={t} />
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
              placeholder="make BTC 40 and add SUI at 10"
              maxLength={400}
              aria-label="Instruction for the agent"
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
              {busy ? "…" : "Send"}
            </button>
          </form>

          {turns.length === 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
              {examplesFor(proposal).map((e) => (
                <button
                  key={e}
                  onClick={() => void send(e)}
                  className="pill pill-quiet"
                  style={{ cursor: "pointer", border: "1px solid var(--line)", background: "transparent" }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Bubble({ turn }: { turn: Turn }) {
  const mine = turn.role === "you";
  return (
    <div style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}>
      <div
        style={{
          maxWidth: "88%",
          padding: "9px 12px",
          borderRadius: "var(--r-sm)",
          background: mine ? "var(--ink)" : "var(--surface-2)",
          color: mine ? "var(--surface)" : "var(--ink)",
          border: mine ? "none" : "1px solid var(--line)",
          fontSize: 12.5,
          lineHeight: 1.55,
        }}
      >
        {turn.pending ? <span style={{ color: "var(--ink-3)" }}>thinking…</span> : turn.text}

        {/* Rendered from the deterministic result, never from the model's prose. */}
        {turn.changes && turn.changes.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
            {turn.changes.map((c) => (
              <span key={c} className="m pill pill-green" style={{ fontSize: 10.5 }}>
                {c}
              </span>
            ))}
          </div>
        )}

        {turn.rejected && turn.rejected.length > 0 && (
          <ul style={{ margin: "8px 0 0", paddingLeft: 16, color: "var(--red)", fontSize: 11.5 }}>
            {turn.rejected.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}

        {turn.warning && (
          <p style={{ margin: "8px 0 0", color: "var(--amber)", fontSize: 11.5 }}>{turn.warning}</p>
        )}
      </div>
    </div>
  );
}
