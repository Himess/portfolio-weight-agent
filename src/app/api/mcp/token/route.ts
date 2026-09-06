import { NextResponse } from "next/server";

import { McpTokenRequestSchema } from "@/lib/api-contracts";
import { forgetDiscovery, discover } from "@/server/mcp-client";
import { setToken } from "@/server/mcp-session";
import { COOKIE, cookieOptions, seal } from "@/server/sealed";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST { token } — accept an access token obtained elsewhere.
 *
 * Binance's OAuth needs a browser and a registered client, so the practical
 * local path is to connect the server once in an MCP client that can do the
 * consent (`claude mcp add binance-mcp-server --transport http
 * https://agent.binance.com/mcp/agentic`) and reuse that token here.
 *
 * The token is held in the server process, never returned to the browser, and
 * is validated immediately by attempting discovery — so a bad paste fails now
 * with a clear reason rather than later inside a trade.
 */
export async function POST(req: Request) {
  try {
    const { token } = McpTokenRequestSchema.parse(await req.json());
    setToken({ accessToken: token, expiresAt: null, obtainedAt: Date.now(), via: "pasted" });
    forgetDiscovery();

    const discovery = await discover(true);

    const res = NextResponse.json({
      connected: true,
      tools: discovery.tools.map((t) => ({ name: t.name, description: t.description })),
      capabilities: discovery.capabilities,
    });
    // Survives a restart or a different serverless instance; a day, since
    // a pasted token carries no stated lifetime.
    const secure = new URL(req.url).protocol === "https:";
    res.cookies.set(
      COOKIE.token,
      seal(
        { accessToken: token, expiresAt: null, obtainedAt: Date.now(), via: "pasted" as const },
        86_400_000,
      ),
      cookieOptions(86_400, secure),
    );
    return res;
  } catch (err) {
    const { clearToken } = await import("@/server/mcp-session");
    clearToken();
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not use that token." },
      { status: 400 },
    );
  }
}
