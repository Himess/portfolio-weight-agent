/**
 * Drive the MCP server the way Claude Code will.
 *
 * Spawns `src/mcp/stdio.ts` as a real subprocess, connects a real MCP client
 * over stdio, and calls every tool in the order a session would. Nothing here
 * is a mock: if this passes, the server works with a client that speaks the
 * protocol, which "it compiles" does not tell you.
 *
 * It also writes `docs/mcp-agent-tools.json` — the tool list as the protocol
 * actually reports it, so the README can cite names that exist rather than
 * names someone typed.
 *
 * Usage:
 *   npm run mcp:check
 *   npm run mcp:check -- --no-llm     # skip the tools that spend model calls
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const noLlm = process.argv.includes("--no-llm");

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };

function parse(res: ToolResult): unknown {
  const text = res.content?.find((c) => c.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function show(label: string, res: ToolResult, keys?: string[]) {
  const body = parse(res) as Record<string, unknown>;
  const mark = res.isError ? "ERROR" : "ok";
  console.log(`\n── ${label}  [${mark}]`);
  if (res.isError) {
    console.log(`   ${String(body.error).slice(0, 200)}`);
    return body;
  }
  for (const k of keys ?? Object.keys(body).slice(0, 6)) {
    const v = body[k];
    const rendered =
      typeof v === "object" && v !== null ? JSON.stringify(v).slice(0, 220) : String(v).slice(0, 220);
    console.log(`   ${k.padEnd(22)} ${rendered}`);
  }
  return body;
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--env-file-if-exists=.env", "--import", "tsx", "src/mcp/stdio.ts"],
    cwd: process.cwd(),
    stderr: "inherit",
  });

  const client = new Client({ name: "mcp-check", version: "1.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`Connected. ${tools.length} tools:`);
  for (const t of tools) console.log(`  ${t.name.padEnd(20)} ${t.title ?? ""}`);

  // The honest capture: names and schemas as the protocol reports them.
  const out = path.resolve("docs/mcp-agent-tools.json");
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(
    out,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        server: "portfolio-weight-agent",
        transport: "stdio",
        note:
          "Captured from a live tools/list over stdio with the SDK client, not written by hand. " +
          "Reproduce with `npm run mcp:check`.",
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title ?? null,
          description: t.description ?? null,
          inputSchema: t.inputSchema,
          annotations: t.annotations ?? null,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nWrote ${path.relative(process.cwd(), out)}`);

  // --- a session, in order -------------------------------------------------

  show(
    "propose_rebalance before any allocation (should refuse)",
    (await client.callTool({
      name: "propose_rebalance",
      arguments: { holdings: [{ symbol: "BTC", qty: 1 }] },
    })) as ToolResult,
    ["error"],
  );

  show(
    "set_allocation  BTC 50 / ETH 30 / USDT 20, tight",
    (await client.callTool({
      name: "set_allocation",
      arguments: {
        targets: [
          { symbol: "BTC", weight: 0.5 },
          { symbol: "ETH", weight: 0.3 },
          { symbol: "USDT", weight: 0.2 },
        ],
        tracking: "tight",
      },
    })) as ToolResult,
    ["ok", "tracking", "bands", "allocation"],
  );

  show(
    "set_allocation with an untradable symbol (should refuse)",
    (await client.callTool({
      name: "set_allocation",
      arguments: {
        targets: [
          { symbol: "HYPE", weight: 0.5 },
          { symbol: "USDT", weight: 0.5 },
        ],
      },
    })) as ToolResult,
    ["error"],
  );

  // Deliberately far from target so there is something to decide about.
  const holdings = [
    { symbol: "BTC", qty: 1.2 },
    { symbol: "ETH", qty: 4 },
    { symbol: "USDT", qty: 5_000 },
  ];

  show(
    "review_portfolio  (pure arithmetic, no model)",
    (await client.callTool({ name: "review_portfolio", arguments: { holdings } })) as ToolResult,
    ["navUsd", "totalDriftPp", "outsideBand", "positions"],
  );

  show(
    "review_portfolio with an unpriceable holding (should refuse)",
    (await client.callTool({
      name: "review_portfolio",
      arguments: { holdings: [...holdings, { symbol: "NOTATOKEN", qty: 5 }] },
    })) as ToolResult,
    ["error", "unpriced"],
  );

  if (noLlm) {
    console.log("\n--no-llm: skipping propose_rebalance / explain_decision.");
  } else {
    const proposal = show(
      "propose_rebalance  (the full loop)",
      (await client.callTool({
        name: "propose_rebalance",
        arguments: { holdings, daysSinceLastRebalance: 30 },
      })) as ToolResult,
      ["verdict", "primaryFactor", "reasoning", "plan", "declined"],
    );

    // The claim under test: a HOLD still returns the trade it declined.
    const verdict = String((proposal as Record<string, unknown>).verdict ?? "");
    const declined = (proposal as { declined?: unknown[] }).declined ?? [];
    console.log(
      `\n   thesis check: verdict ${verdict}, ${declined.length} declined leg(s) returned` +
        (verdict === "HOLD" && declined.length === 0
          ? "  <-- FAIL: a HOLD must show what it declined"
          : "  ok"),
    );

    show(
      "explain_decision  (from the stored fact sheet)",
      (await client.callTool({
        name: "explain_decision",
        arguments: { question: "why did you not act on ETH?" },
      })) as ToolResult,
      ["verdict", "primaryFactor", "positions", "declinedTrades"],
    );
  }

  show(
    "list_decisions",
    (await client.callTool({ name: "list_decisions", arguments: { limit: 5 } })) as ToolResult,
    ["count", "summary", "decisions"],
  );

  await client.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
