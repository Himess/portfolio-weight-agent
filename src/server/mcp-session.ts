/**
 * Binance MCP connection: OAuth client and token store.
 *
 * What the server actually requires, read from its own metadata rather than
 * assumed (`https://agent.binance.com/.well-known/oauth-authorization-server`):
 *
 *   grant_types_supported              ["authorization_code"]   — no client_credentials
 *   code_challenge_methods_supported   ["S256"]                 — PKCE is mandatory
 *   token_endpoint_auth_methods_supported ["none"]              — public client, no secret
 *   client_id_metadata_document_supported true                  — client_id may be a URL
 *   registration_endpoint              (absent)                 — no dynamic registration
 *
 * The consequence is the one already documented in the README: there is no
 * headless path. A human must approve in a browser. This module does everything
 * around that — PKCE, state, the exchange, storage — but the consent itself is
 * theirs to give.
 *
 * Tokens live in this process only. They are never sent to the browser, never
 * written to disk, and are lost on restart. For a single-user local app that is
 * the right trade: nothing to leak from a file, and re-consenting is one click.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const MCP_ENDPOINT = process.env.BINANCE_MCP_URL ?? "https://agent.binance.com/mcp/agentic";
const AS_METADATA = "https://agent.binance.com/.well-known/oauth-authorization-server";

export type AuthServerMetadata = {
  authorization_endpoint: string;
  token_endpoint: string;
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
};

let metadataCache: { at: number; data: AuthServerMetadata } | null = null;

export async function authServerMetadata(): Promise<AuthServerMetadata> {
  if (metadataCache && Date.now() - metadataCache.at < 3_600_000) return metadataCache.data;
  const res = await fetch(AS_METADATA);
  if (!res.ok) throw new Error(`OAuth metadata unavailable (HTTP ${res.status})`);
  const data = (await res.json()) as AuthServerMetadata;
  if (!data.authorization_endpoint || !data.token_endpoint) {
    throw new Error("OAuth metadata is missing required endpoints");
  }
  metadataCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

const base64url = (b: Buffer) => b.toString("base64url");

/** RFC 7636: 43-128 chars from the unreserved set. 32 random bytes gives 43. */
export function createVerifier(): string {
  return base64url(randomBytes(32));
}

export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function createState(): string {
  return base64url(randomBytes(16));
}

/** Constant-time compare, so a returned state cannot be probed byte by byte. */
export function statesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Pending authorizations
// ---------------------------------------------------------------------------

type Pending = { verifier: string; createdAt: number; redirectUri: string };

const pending = new Map<string, Pending>();
const PENDING_TTL_MS = 10 * 60_000;

export function rememberPending(state: string, verifier: string, redirectUri: string): void {
  sweep();
  pending.set(state, { verifier, createdAt: Date.now(), redirectUri });
}

/** One-shot: a state is consumed on use, so a replayed callback fails. */
export function consumePending(state: string): Pending | null {
  sweep();
  for (const [key, value] of pending) {
    if (statesMatch(key, state)) {
      pending.delete(key);
      return value;
    }
  }
  return null;
}

function sweep(): void {
  const now = Date.now();
  for (const [key, value] of pending) {
    if (now - value.createdAt > PENDING_TTL_MS) pending.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

export type McpToken = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms, or null when the server did not say */
  expiresAt: number | null;
  obtainedAt: number;
  /** How it arrived, so the UI can be honest about it */
  via: "oauth" | "pasted" | "env";
};

let token: McpToken | null = null;

export function setToken(next: McpToken): void {
  token = next;
}

export function getToken(): McpToken | null {
  if (token) return token;
  // A token supplied by the environment behaves the same as a granted one.
  const fromEnv = process.env.BINANCE_MCP_TOKEN;
  if (fromEnv) {
    token = { accessToken: fromEnv, expiresAt: null, obtainedAt: Date.now(), via: "env" };
    return token;
  }
  return null;
}

export function clearToken(): void {
  token = null;
}

export function tokenExpired(t: McpToken, skewMs = 30_000): boolean {
  return t.expiresAt != null && Date.now() + skewMs >= t.expiresAt;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

/**
 * The client identifier.
 *
 * The server advertises `client_id_metadata_document_supported`, meaning a
 * client may identify itself by the HTTPS URL of a metadata document rather
 * than by pre-registration — which is how editors connect without Binance
 * issuing them a secret. That requires the document to be publicly reachable,
 * so it only works once this app is deployed; set BINANCE_MCP_CLIENT_ID to that
 * URL then.
 *
 * Using another product's identifier would be impersonating it, so there is no
 * default. Without one, the app falls back to a pasted token.
 */
export function clientId(): string | null {
  return process.env.BINANCE_MCP_CLIENT_ID ?? null;
}

export async function buildAuthorizeUrl(redirectUri: string): Promise<{ url: string; state: string }> {
  const id = clientId();
  if (!id) {
    throw new Error(
      "No BINANCE_MCP_CLIENT_ID set. Binance issues no dynamic registration, so a client must " +
        "identify itself by a publicly reachable metadata-document URL — which needs this app " +
        "deployed. Until then, connect the server in an MCP client and paste its access token.",
    );
  }

  const meta = await authServerMetadata();
  const verifier = createVerifier();
  const state = createState();
  rememberPending(state, verifier, redirectUri);

  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challengeFor(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", MCP_ENDPOINT);

  return { url: url.toString(), state };
}

export async function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<McpToken> {
  const meta = await authServerMetadata();
  const id = clientId();
  if (!id) throw new Error("No BINANCE_MCP_CLIENT_ID set.");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: id,
    code_verifier: verifier,
    resource: MCP_ENDPOINT,
  });

  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed (HTTP ${res.status}): ${text.slice(0, 300)}`);

  const json = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) throw new Error("Token endpoint returned no access_token");

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : null,
    obtainedAt: Date.now(),
    via: "oauth",
  };
}
