/**
 * MCP tool discovery — DESIGN.md §9.2.
 *
 * "Do not hardcode MCP tool names. Call tools/list. Log the full response
 *  verbatim into docs/mcp-tools.json — commit it. It is itself a contribution,
 *  since Binance has not published this."
 *
 * The Binance MCP server is OAuth-gated (authorization_code + PKCE, no
 * client_credentials grant), so this script cannot complete the handshake on
 * its own. It does two things:
 *
 *   1. Records the server's advertised OAuth metadata and its unauthenticated
 *      response — both are facts worth committing.
 *   2. If you supply a bearer token (BINANCE_MCP_TOKEN), performs the real
 *      initialize + tools/list and writes the verbatim result.
 *
 * Getting a token: connect the server once in an MCP client that does the OAuth
 * dance (Claude Code: `claude mcp add binance-mcp-server --transport http
 * https://agent.binance.com/mcp/agentic`), then export the access token it
 * stored. See README "Connecting the MCP server".
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ENDPOINT = process.env.BINANCE_MCP_URL ?? "https://agent.binance.com/mcp/agentic";
const TOKEN = process.env.BINANCE_MCP_TOKEN;
const OUT = path.resolve("docs/mcp-tools.json");

type Json = Record<string, unknown>;

async function rpc(method: string, params: Json, token?: string) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });

  const text = await res.text();
  let parsed: unknown = text;
  try {
    // Streamable HTTP may reply as SSE; pull the first data: line if so.
    const data = text.startsWith("event:") || text.startsWith("data:")
      ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
      : text;
    if (data) parsed = JSON.parse(data);
  } catch {
    /* keep raw text */
  }

  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: parsed,
  };
}

async function main() {
  const record: Json = {
    endpoint: ENDPOINT,
    discoveredAt: new Date().toISOString(),
    note:
      "Binance does not publish the MCP tool list. This file is captured from the live server " +
      "with an authenticated session. Without a bearer token the server returns 401 and only " +
      "the OAuth metadata is recorded. tools/list is paginated at 50 — a single call sees the " +
      "first page only, which is why this follows nextCursor to exhaustion.",
  };

  // OAuth metadata is public and worth committing on its own.
  try {
    const meta = await fetch("https://agent.binance.com/.well-known/oauth-authorization-server");
    record.oauthAuthorizationServer = { status: meta.status, body: await meta.json() };
  } catch (err) {
    record.oauthAuthorizationServer = { error: String(err) };
  }

  const unauth = await rpc("tools/list", {});
  record.unauthenticatedToolsList = {
    status: unauth.status,
    wwwAuthenticate: unauth.headers["www-authenticate"] ?? null,
  };

  if (!TOKEN) {
    record.tools = null;
    record.status = "NOT_DISCOVERED — set BINANCE_MCP_TOKEN to capture the real tool list";
    console.warn(
      "No BINANCE_MCP_TOKEN set. Wrote OAuth metadata and the 401 response only.\n" +
        "The app runs fine without this — the read/analysis path uses public market data.",
    );
  } else {
    const init = await rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "portfolio-weight-agent", version: "1.0.0" },
      },
      TOKEN,
    );
    record.initialize = init.body;

    // The server paginates. A single tools/list returns 50 and a `nextCursor`,
    // which is easy to miss and leaves you believing the surface is a third
    // smaller than it is — the first capture stopped at `margin.*` and never
    // saw spot, wallet or sub-account. Nothing in Binance's docs mentions the
    // page size, so this follows the cursor until the server stops sending one.
    type ToolsResult = { result?: { tools?: { name: string }[]; nextCursor?: string } };
    const pages: unknown[] = [];
    const all: { name: string }[] = [];
    let cursor: string | undefined;
    let status = 0;

    do {
      const page = await rpc("tools/list", cursor ? { cursor } : {}, TOKEN);
      status = page.status;
      pages.push(page.body);
      const result = (page.body as ToolsResult)?.result;
      if (result?.tools) all.push(...result.tools);
      cursor = result?.nextCursor;
      if (pages.length > 20) break; // a cursor that never clears is a bug, not a big list
    } while (cursor);

    record.tools = {
      pages: pages.length,
      pageSize: (pages[0] as ToolsResult)?.result?.tools?.length ?? null,
      count: all.length,
      names: all.map((t) => t.name),
      // Verbatim, every page, because the schemas are the part nobody publishes.
      responses: pages,
    };
    record.status = status === 200 ? "DISCOVERED" : `HTTP ${status}`;

    console.log(`Discovered ${all.length} tools across ${pages.length} page(s):`);
    for (const t of all) console.log("  -", t.name);
  }

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(record, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
