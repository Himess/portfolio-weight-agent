"use client";

/**
 * Standing alerts, in Telegram.
 *
 * The gap this closes is the one the rest of the app cannot: a rebalance
 * decision is not something you remember to go and ask for. Drift happens while
 * you are not looking, and by the time you think to check, the moment the agent
 * would have flagged has usually passed.
 *
 * What arrives is deliberately not a price alert. It fires on the same band the
 * app draws on screen, and it carries the agent's verdict — including the
 * verdict to wait, which is the one a threshold bot can never send.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { Allocation, Preference } from "@/types";

const STORE_KEY = "pwa.watch.v1";

type Created = { id: string; deepLink: string; botUsername: string };

type Status = {
  found: boolean;
  bound?: boolean;
  paused?: boolean;
  label?: string | null;
  repeatAfterHours?: number;
  lastCheckedAt?: string | null;
  lastNotifiedAt?: string | null;
  lastVerdict?: string | null;
};

function remember(id: string) {
  try {
    window.localStorage.setItem(STORE_KEY, id);
  } catch {
    /* storage off; the watch still exists server-side, we just cannot recall it */
  }
}

function recall(): string | null {
  try {
    return window.localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function forget() {
  try {
    window.localStorage.removeItem(STORE_KEY);
  } catch {
    /* nothing to do */
  }
}

export function Watch({
  allocation,
  quantities,
  preference,
  available,
}: {
  allocation: Allocation;
  quantities: Record<string, number>;
  preference: Preference;
  /** False when the deployment has no bot token — the card explains instead of failing. */
  available: boolean;
}) {
  const [created, setCreated] = useState<Created | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repeatAfterHours, setRepeat] = useState(24);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/watch?id=${encodeURIComponent(id)}`);
      const json = (await res.json()) as Status;
      setStatus(json);
      // A watch that no longer exists server-side should not keep being polled.
      if (!json.found) forget();
      return json;
    } catch {
      return null;
    }
  }, []);

  // Pick up a watch created in an earlier session.
  useEffect(() => {
    const id = recall();
    if (!id) return;
    setCreated({ id, deepLink: "", botUsername: "" });
    void refresh(id);
  }, [refresh]);

  // While a link is open but unbound, poll — the user is over in Telegram
  // pressing Start, and the card should notice without them coming back to it.
  useEffect(() => {
    const id = created?.id;
    if (!id || status?.bound) {
      if (timer.current) clearInterval(timer.current);
      return;
    }
    timer.current = setInterval(() => void refresh(id), 2500);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [created?.id, status?.bound, refresh]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allocation,
          quantities,
          preference,
          label: allocation.targets.map((t) => (t.kind === "asset" ? t.symbol : t.label)).join(" / "),
          repeatAfterHours,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not create the watch.");
      setCreated(json as Created);
      remember((json as Created).id);
      setStatus({ found: true, bound: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!created) return;
    setBusy(true);
    try {
      await fetch(`/api/watch?id=${encodeURIComponent(created.id)}`, { method: "DELETE" });
    } finally {
      forget();
      setCreated(null);
      setStatus(null);
      setBusy(false);
    }
  }

  if (!available) {
    return (
      <Card>
        <Head />
        <p style={p}>
          This deployment has no Telegram bot configured, so alerts are off. The rest of the agent
          works exactly the same — you just have to come and ask it.
        </p>
      </Card>
    );
  }

  // ---- bound: the steady state --------------------------------------------
  if (created && status?.bound) {
    return (
      <Card>
        <Head badge={status.paused ? "paused" : "on"} />
        <p style={p}>
          Watching this allocation against live Binance prices. You will hear from the agent when a
          position leaves its band — with what it decided, including deciding to wait.
        </p>
        <dl style={grid}>
          <Row k="Trigger" v="the same band the app uses — set by your tracking choice" />
          <Row
            k="Repeats"
            v={`an unchanged verdict at most every ${status.repeatAfterHours ?? repeatAfterHours}h`}
          />
          <Row
            k="Last checked"
            v={status.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleString() : "not yet"}
          />
          {status.lastVerdict && <Row k="Last verdict" v={status.lastVerdict} />}
        </dl>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
          <button className="btn" onClick={remove} disabled={busy}>
            Stop watching
          </button>
          <span style={{ fontSize: 11.5, color: "var(--ink-3)", alignSelf: "center" }}>
            or send /pause in the chat
          </span>
        </div>
      </Card>
    );
  }

  // ---- created, waiting for the Start press -------------------------------
  if (created?.deepLink) {
    return (
      <Card>
        <Head badge="one step left" />
        <p style={p}>
          Open the bot and press <b>Start</b>. Telegram will not let anything be sent to you until you
          do — that is its rule, not a setting this app could change.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 14 }}>
          <a className="btn btn-primary" href={created.deepLink} target="_blank" rel="noreferrer">
            Open @{created.botUsername}
          </a>
          <span className="pill pill-quiet">waiting…</span>
        </div>
        <p style={{ ...p, fontSize: 11.5, marginTop: 12 }}>
          On a different device? The link is <span className="m">{created.deepLink}</span>
        </p>
      </Card>
    );
  }

  // ---- nothing yet ---------------------------------------------------------
  return (
    <Card>
      <Head />
      <p style={p}>
        Drift happens while you are not looking. Get a message when this allocation crosses a band —
        carrying the agent&rsquo;s call, not just a number.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 16 }}>
        <button className="btn btn-primary" onClick={create} disabled={busy}>
          {busy ? "Setting up…" : "Alert me in Telegram"}
        </button>
        <label style={{ fontSize: 12, color: "var(--ink-2)", display: "flex", alignItems: "center", gap: 8 }}>
          repeat an unchanged verdict every
          <select
            value={repeatAfterHours}
            onChange={(e) => setRepeat(Number(e.target.value))}
            style={{ font: "inherit", padding: "5px 8px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface)" }}
          >
            <option value={6}>6h</option>
            <option value={24}>24h</option>
            <option value={72}>3 days</option>
            <option value={168}>a week</option>
          </select>
        </label>
      </div>
      {error && (
        <p style={{ ...p, color: "var(--red)", marginTop: 12 }} role="alert">
          {error}
        </p>
      )}
      <p style={{ ...p, fontSize: 11.5, marginTop: 12 }}>
        The bot can only message you. It cannot place, cancel or approve an order — approval stays in
        your own client, which asks before it sends.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------

const p: React.CSSProperties = {
  fontSize: 13.5,
  color: "var(--ink-2)",
  margin: "10px 0 0",
  maxWidth: "64ch",
  lineHeight: 1.6,
};

const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  gap: "6px 16px",
  margin: "16px 0 0",
  fontSize: 12.5,
};

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt style={{ color: "var(--ink-3)" }}>{k}</dt>
      <dd style={{ margin: 0, color: "var(--ink-2)" }}>{v}</dd>
    </>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: "24px 28px" }}>
      {children}
    </div>
  );
}

function Head({ badge }: { badge?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Tell me when it matters</h2>
      {badge && <span className="pill pill-accent">{badge}</span>}
    </div>
  );
}
