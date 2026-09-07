import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createServer } from "@/mcp/server";
import { REVIEW_LIMIT, rateLimit } from "@/server/guard";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * The agent's MCP server, over HTTP.
 *
 * Note the two different meanings of "mcp" in this directory, because they are
 * easy to confuse. The subdirectories — `auth/`, `status/`, `token/` — are this
 * app acting as a *client* of Binance's MCP server. This file is the opposite:
 * this app *being* an MCP server that Claude Code (or any MCP client) can call.
 *
 * Stdio is the transport that has to work, and does; this exists so a reviewer
 * can add the server from the deployed URL without cloning anything.
 *
 * Stateless on purpose. Serverless has no session affinity, so a session id
 * issued by one instance would be meaningless to the next; each request carries
 * everything it needs and durable state lives in the agent store.
 *
 * Exposure is the same as the web app's own /api/review — the tools read public
 * market data and spend model calls, so the same per-client budget applies.
 * There is no tool here that trades, and none that reads anyone's account:
 * holdings arrive as arguments from whoever is calling.
 */
async function handle(req: Request): Promise<Response> {
  const limited = rateLimit(req, "mcp", REVIEW_LIMIT);
  if (limited) return limited;

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const server = createServer();
  await server.connect(transport);

  try {
    return await transport.handleRequest(req);
  } finally {
    // One server per request in stateless mode; leaving them connected would
    // leak a listener per call.
    await server.close().catch(() => {});
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
