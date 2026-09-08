"use client";

/**
 * Connecting to the Binance MCP server.
 *
 * This is where the app stops being a calculator and starts being able to read
 * your real balances and hand orders to Binance. What it can offer depends on
 * something outside our control, so the panel is explicit about it:
 *
 * Binance issues no dynamic client registration and no machine-to-machine
 * grant. A client identifies itself either by pre-arrangement or by the URL of
 * a publicly reachable metadata document — which needs this app deployed. On
 * localhost neither is available, so the honest path is to reuse a token from
 * an MCP client that already completed the consent.
 *
 * The token is posted once, held server-side, and never comes back to the
 * browser. It is validated on arrival by attempting discovery, so a bad paste
 * fails here rather than inside a trade.
 */

import { useCallback, useEffect, useState } from "react";

type Status = {
  connected: boolean;
  endpoint: string;
  oauthAvailable: boolean;
  via?: "oauth" | "pasted" | "env";
  expiresAt?: number | null;
  error?: string | null;
  reason?: string;
  tools?: { name: string; description?: string }[];
  capabilities?: { balances: string | null; placeOrder: string | null; orderStatus: string | null } | null;
  discoveredAt?: string | null;
};

export function McpPanel({ onConnectionChange }: { onConnectionChange?: (connected: boolean) => void } = {}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);

  const refresh = useCallback(() => {
    fetch("/api/mcp/status")
      .then((r) => r.json())
      .then((s: Status) => {
        setStatus(s);
        // The data-source picker can only offer the account once it is usable —
        // connected is not enough, it must also expose a balance tool.
        onConnectionChange?.(Boolean(s.connected && s.capabilities?.balances));
      })
      .catch(() => setError("Could not read the connection status."));
  }, [onConnectionChange]);

  useEffect(() => {
    refresh();
    // Surface the outcome of a returning OAuth redirect.
    const params = new URLSearchParams(window.location.search);
    const err = params.get("mcp_error");
    if (err) setError(err);
    if (err || params.get("mcp_connected")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [refresh]);

  async function submitToken() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not use that token.");
      setToken("");
      setShowPaste(false);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    await fetch("/api/mcp/status", { method: "DELETE" });
    refresh();
  }

  const connected = status?.connected && (status.tools?.length ?? 0) > 0;

  return (
    <div className="card card-p">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
          Binance account <span style={{ fontWeight: 500, color: "var(--ink-3)" }}>· optional</span>
        </h2>
        <span className={connected ? "pill pill-green" : "pill pill-quiet"} style={{ padding: "3px 10px", fontSize: 11 }}>
          {connected ? "connected" : "not connected"}
        </span>
      </div>

      {!connected && (
        <>
          <p style={{ fontSize: 12, color: "var(--ink-2)", margin: "9px 0 0", lineHeight: 1.55 }}>
            Connect to read your real balances and send approved orders. Without it the app still
            works on live public market data with holdings you enter yourself.
          </p>

          {status?.oauthAvailable ? (
            <a
              className="btn btn-primary"
              href="/api/mcp/auth/start"
              style={{ width: "100%", marginTop: 12, textDecoration: "none" }}
            >
              Connect with Binance
            </a>
          ) : (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: "var(--r-sm)",
                background: "var(--surface-2)",
                border: "1px solid var(--line)",
                fontSize: 11.5,
                color: "var(--ink-2)",
                lineHeight: 1.55,
              }}
            >
              <b style={{ color: "var(--ink)" }}>There is no sign-in button here, and that is deliberate.</b>{" "}
              Binance only lets an app open its consent screen if Binance has registered that app in
              advance — there is no self-service route. This one is a hackathon entry, not a
              registered Binance partner, so it has nothing to sign you in with. Borrowing another
              product&rsquo;s registration would mean showing you their name on the consent screen,
              which would be a lie about who you were approving.
              <br />
              <br />
              Nothing is missing from the agent because of it. It reads live Binance prices either
              way; the only difference is that you type your holdings in yourself instead of it
              reading your balances.
              <details style={{ marginTop: 10 }}>
                <summary style={{ cursor: "pointer", color: "var(--ink-3)" }}>
                  Already have a Binance MCP session? (developers)
                </summary>
                <span style={{ display: "block", marginTop: 8 }}>
                  Connect the server once in an MCP client and reuse the token it holds:
                </span>
                <code
                  style={{
                    display: "block",
                    marginTop: 8,
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    color: "var(--ink)",
                    wordBreak: "break-all",
                  }}
                >
                  claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
                </code>
              </details>
            </div>
          )}

          {!showPaste ? (
            <button
              className="btn"
              style={{ width: "100%", marginTop: 8 }}
              onClick={() => setShowPaste(true)}
              title="For a token from an MCP client that has already completed Binance's consent flow"
            >
              I have an access token
            </button>
          ) : (
            <div style={{ marginTop: 10 }}>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Bearer token from your MCP client"
                type="password"
                /*
                 * Masked because it is a live credential, and marked so that no
                 * password manager offers to save it. Browsers largely ignore
                 * autoComplete="off" on a password field; "one-time-code" is the
                 * value they do not offer to remember, and the data-* opt-outs
                 * cover 1Password, LastPass and Bitwarden. Without these, pasting
                 * this raises a "save password?" bubble — over the top of a
                 * screen someone may well be recording.
                 */
                autoComplete="one-time-code"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                data-form-type="other"
                spellCheck={false}
                style={{
                  width: "100%",
                  padding: "9px 11px",
                  borderRadius: "var(--r-sm)",
                  border: "1px solid var(--line-2)",
                  background: "var(--surface-2)",
                  fontSize: 12,
                  fontFamily: "var(--mono)",
                  outline: "none",
                }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="btn btn-primary" onClick={submitToken} disabled={busy || token.trim().length < 20} style={{ flex: 1 }}>
                  {busy ? "Checking…" : "Connect"}
                </button>
                <button className="btn" onClick={() => { setShowPaste(false); setToken(""); }}>
                  Cancel
                </button>
              </div>
              <p style={{ fontSize: 10.5, color: "var(--ink-3)", margin: "8px 0 0", lineHeight: 1.5 }}>
                Held in the server process only — never stored on disk, never returned to this page,
                and gone when the server restarts.
              </p>
            </div>
          )}
        </>
      )}

      {connected && status && (
        <>
          <div style={{ display: "flex", gap: 16, marginTop: 12 }}>
            <div>
              <div className="m" style={{ fontSize: 19, fontWeight: 700 }}>
                {status.tools?.length ?? 0}
              </div>
              <div className="lbl">tools found</div>
            </div>
            <div>
              <div className="m" style={{ fontSize: 19, fontWeight: 700, color: status.capabilities?.placeOrder ? "var(--green)" : "var(--ink-3)" }}>
                {status.capabilities?.placeOrder ? "yes" : "no"}
              </div>
              <div className="lbl">can send orders</div>
            </div>
          </div>

          <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "10px 0 0", lineHeight: 1.55 }}>
            Tool names were discovered at runtime, not hardcoded — Binance publishes none. Every
            order still needs your confirmation in Binance, and there is no withdrawal scope.
          </p>

          {status.tools && status.tools.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ fontSize: 11.5, color: "var(--ink-2)", cursor: "pointer" }}>
                What it exposes
              </summary>
              <div className="m" style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.7 }}>
                {status.tools.map((t) => (
                  <div key={t.name}>{t.name}</div>
                ))}
              </div>
            </details>
          )}

          <button className="btn" style={{ width: "100%", marginTop: 12 }} onClick={disconnect}>
            Disconnect
          </button>
        </>
      )}

      {(error || status?.error) && (
        <p style={{ fontSize: 11.5, color: "var(--red)", margin: "10px 0 0", lineHeight: 1.5 }}>
          {error ?? status?.error}
        </p>
      )}
    </div>
  );
}
