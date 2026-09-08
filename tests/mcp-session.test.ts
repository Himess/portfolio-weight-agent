import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  challengeFor,
  clearToken,
  consumePending,
  createState,
  createVerifier,
  getToken,
  rememberPending,
  setToken,
  statesMatch,
  tokenExpired,
} from "../src/server/mcp-session";

/**
 * Binance's MCP server requires PKCE with S256 and issues no client secret, so
 * the verifier and the one-shot state are the only things standing between a
 * stolen authorization code and a working token. Worth testing properly.
 */

describe("PKCE", () => {
  it("produces a verifier in the RFC 7636 length range", () => {
    for (let i = 0; i < 20; i++) {
      const v = createVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      // base64url only: no +, /, or padding
      expect(v).toMatch(/^[A-Za-z0-9\-_]+$/);
    }
  });

  it("produces a fresh verifier each time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => createVerifier()));
    expect(seen.size).toBe(50);
  });

  it("derives the S256 challenge exactly as the spec defines it", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challengeFor(verifier)).toBe(expected);
    // A challenge must not be the verifier — that would defeat the point.
    expect(challengeFor(verifier)).not.toBe(verifier);
  });
});

describe("state", () => {
  it("matches itself and rejects anything else", () => {
    const s = createState();
    expect(statesMatch(s, s)).toBe(true);
    expect(statesMatch(s, createState())).toBe(false);
    expect(statesMatch(s, s + "x")).toBe(false);
    expect(statesMatch(s, "")).toBe(false);
  });

  it("is consumed exactly once, so a replayed callback fails", () => {
    const state = createState();
    rememberPending(state, createVerifier(), "http://localhost:3000/cb");

    expect(consumePending(state)).not.toBeNull();
    // The replay — same state, second time.
    expect(consumePending(state)).toBeNull();
  });

  it("returns nothing for a state that was never issued", () => {
    expect(consumePending(createState())).toBeNull();
  });

  it("hands back the verifier and redirect it was stored with", () => {
    const state = createState();
    const verifier = createVerifier();
    rememberPending(state, verifier, "http://localhost:3000/cb");

    const pending = consumePending(state);
    expect(pending?.verifier).toBe(verifier);
    expect(pending?.redirectUri).toBe("http://localhost:3000/cb");
  });
});

describe("token store", () => {
  it("holds and clears a token", () => {
    clearToken();
    setToken({ accessToken: "abc123", expiresAt: null, obtainedAt: Date.now(), via: "pasted" });
    expect(getToken()?.accessToken).toBe("abc123");
    clearToken();
    // With no env token set, cleared means gone.
    if (!process.env.BINANCE_MCP_TOKEN) expect(getToken()).toBeNull();
  });

  it("treats a token as expired slightly before it actually is", () => {
    const now = Date.now();
    // Inside the skew window: still 10s of life, but not enough to start a call.
    expect(tokenExpired({ accessToken: "x", expiresAt: now + 10_000, obtainedAt: now, via: "oauth" })).toBe(true);
    expect(tokenExpired({ accessToken: "x", expiresAt: now + 300_000, obtainedAt: now, via: "oauth" })).toBe(false);
  });

  it("never expires a token whose lifetime the server did not state", () => {
    expect(tokenExpired({ accessToken: "x", expiresAt: null, obtainedAt: 0, via: "pasted" })).toBe(false);
  });
});

/**
 * One visitor's account must never be visible to the next.
 *
 * The token lives in a module-level variable, which on serverless is shared by
 * every request the warm instance serves. `restoreSession` used to return early
 * when a request carried no cookie, and `adoptToken` used to assign only when
 * given something — so a stranger's cookie-less request inherited whatever the
 * previous caller had connected, and `/api/mcp/status` answered it with their
 * real balances. The site was public when this was found. These tests are the
 * reason it cannot come back.
 */
describe("a session belongs to one visitor", () => {
  it("clears the connected account when a request carries no session", async () => {
    const { adoptToken } = await import("../src/server/mcp-session");
    delete process.env.BINANCE_MCP_TOKEN;

    setToken({ accessToken: "someone-elses", expiresAt: null, obtainedAt: Date.now(), via: "pasted" });
    expect(getToken()?.accessToken).toBe("someone-elses");

    // The next request arrives with no cookie.
    adoptToken(null);
    expect(getToken()).toBeNull();
  });

  it("restoreSession forgets the previous caller when the cookie is absent", async () => {
    const { restoreSession } = await import("../src/server/guard");
    delete process.env.BINANCE_MCP_TOKEN;

    setToken({ accessToken: "someone-elses", expiresAt: null, obtainedAt: Date.now(), via: "pasted" });
    restoreSession(new Request("https://example.test/api/mcp/status"));
    expect(getToken()).toBeNull();
  });

  it("forgets it even when the request has cookies, just not ours", async () => {
    const { restoreSession } = await import("../src/server/guard");
    delete process.env.BINANCE_MCP_TOKEN;

    setToken({ accessToken: "someone-elses", expiresAt: null, obtainedAt: Date.now(), via: "pasted" });
    restoreSession(
      new Request("https://example.test/api/mcp/status", {
        headers: { cookie: "theme=dark; _vercel_jwt=abc" },
      }),
    );
    expect(getToken()).toBeNull();
  });

  it("still restores the visitor's own sealed session", async () => {
    const { restoreSession } = await import("../src/server/guard");
    const { COOKIE, seal } = await import("../src/server/sealed");
    delete process.env.BINANCE_MCP_TOKEN;
    clearToken();

    const mine = { accessToken: "mine", expiresAt: null, obtainedAt: Date.now(), via: "pasted" as const };
    restoreSession(
      new Request("https://example.test/api/mcp/status", {
        headers: { cookie: `${COOKIE.token}=${seal(mine, 86_400_000)}` },
      }),
    );
    expect(getToken()?.accessToken).toBe("mine");
  });
});
