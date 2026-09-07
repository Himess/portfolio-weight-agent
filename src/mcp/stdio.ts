#!/usr/bin/env node
/**
 * Stdio entrypoint — what Claude Code launches.
 *
 * Nothing may be written to stdout except MCP frames: stdout *is* the
 * transport, and one stray console.log corrupts the stream and the client
 * disconnects with an unhelpful parse error. Diagnostics go to stderr, which
 * Claude Code shows in its logs.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server";
import { describeState } from "../server/agent-state";
import { llmAvailable, providerLabel } from "../server/session";

async function main() {
  const state = describeState();

  // stderr on purpose — see above.
  console.error(
    [
      "portfolio-weight-agent MCP server",
      `  judgment layer : ${llmAvailable() ? providerLabel() : "none — deterministic fallback, labelled as such"}`,
      `  memory         : ${state.kind}${state.durable ? "" : " (not durable; allocation is lost on restart)"}`,
      "  market data    : Binance public endpoints, fetched directly",
      "  orders         : never placed. Plans are returned for you to send.",
    ].join("\n"),
  );

  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("[mcp] failed to start:", err);
  process.exit(1);
});
