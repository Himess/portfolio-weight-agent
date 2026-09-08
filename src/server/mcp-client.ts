/**
 * Talking to the Binance MCP server with the stored token.
 *
 * Nothing here hardcodes a tool name. Binance does not publish them, so
 * capabilities are resolved from whatever `tools/list` actually returns (see
 * src/adapters/mcp.ts). This module is the transport plus the discovery cache.
 */

import { resolveCapabilities, type McpTool, type ResolvedCapabilities } from "../adapters/mcp";
import { MCP_ENDPOINT, getToken, tokenExpired } from "./mcp-session";

export type Discovery = {
  tools: McpTool[];
  capabilities: ResolvedCapabilities;
  discoveredAt: string;
};

let discovery: Discovery | null = null;

export function cachedDiscovery(): Discovery | null {
  return discovery;
}

export function forgetDiscovery(): void {
  discovery = null;
}

export class NotConnected extends Error {
  constructor(msg = "Not connected to the Binance MCP server.") {
    super(msg);
  }
}

async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const token = getToken();
  if (!token) throw new NotConnected();
  if (tokenExpired(token)) {
    throw new NotConnected("The Binance authorization has expired — connect again.");
  }

  const res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token.accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });

  const text = await res.text();

  if (res.status === 401) {
    // "Rejected" is accurate and useless on its own. In practice a 401 here has
    // one overwhelming cause: the token was rotated. Reconnecting the server in
    // an MCP client — including re-consenting to change scopes — issues a new
    // one and kills the old immediately, so a token copied minutes earlier is
    // already dead. Saying so turns a dead end into one action.
    throw new NotConnected(
      "Binance rejected this token (401). It has almost certainly been rotated — " +
        "reconnecting the server in your MCP client, or re-consenting to change scopes, " +
        "issues a new token and invalidates the old one. Copy the current token and paste it again.",
    );
  }
  if (!res.ok) {
    throw new Error(`MCP ${method} failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  // Streamable HTTP may answer as SSE; take the first data frame.
  const payload =
    text.startsWith("event:") || text.startsWith("data:")
      ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
      : text;

  const parsed = JSON.parse(payload ?? text) as {
    error?: { message?: string; code?: number };
    result?: unknown;
  };
  if (parsed.error) throw new Error(`MCP ${method}: ${parsed.error.message ?? "unknown error"}`);
  return parsed.result;
}

/**
 * Handshake then enumerate. The result is committed to docs/mcp-tools.json by
 * the discovery script — Binance publishes no tool list, so ours is worth
 * keeping.
 */
export async function discover(force = false): Promise<Discovery> {
  if (discovery && !force) return discovery;

  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "portfolio-weight-agent", version: "1.0.0" },
  });

  // Binance paginates tools/list at 50 and documents neither the page size nor
  // the cursor. A single call returns a plausible-looking list that stops inside
  // `margin.*` — no spot, no wallet, no sub-account — so capability resolution
  // would decide the server cannot place an order while it plainly can, and the
  // panel would report a tool count a third short. Follow the cursor.
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const result = (await rpc("tools/list", cursor ? { cursor } : {})) as
      | { tools?: McpTool[]; nextCursor?: string }
      | undefined;
    if (Array.isArray(result?.tools)) tools.push(...result.tools);
    cursor = result?.nextCursor;
    pages += 1;
  } while (cursor && pages < 20); // a cursor that never clears is a bug, not a long list

  discovery = {
    tools,
    capabilities: resolveCapabilities(tools),
    discoveredAt: new Date().toISOString(),
  };
  return discovery;
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  return rpc("tools/call", { name, arguments: args });
}
