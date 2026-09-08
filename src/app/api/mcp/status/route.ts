import { NextResponse } from "next/server";

import { parseBalances } from "@/adapters/mcp";
import { callTool, cachedDiscovery, discover, NotConnected } from "@/server/mcp-client";
import { restoreSession } from "@/server/guard";
import { clientId, getToken, MCP_ENDPOINT } from "@/server/mcp-session";

export const runtime = "nodejs";

/** GET — is the MCP server connected, and what did it turn out to expose? */
export async function GET(req: Request) {
  restoreSession(req);
  const token = getToken();

  if (!token) {
    return NextResponse.json({
      connected: false,
      endpoint: MCP_ENDPOINT,
      // Whether the browser flow is even available here, so the UI can offer
      // the right path instead of a button that cannot work.
      oauthAvailable: Boolean(clientId()),
      reason:
        "Not connected. Binance offers no dynamic client registration and no machine-to-machine grant, so this needs either a deployed client-metadata URL or a token from an MCP client that already completed the consent.",
    });
  }

  let discovery = cachedDiscovery();
  let error: string | null = null;
  if (!discovery) {
    try {
      discovery = await discover();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  // What the account actually holds, so connecting one shows something. Twice
  // now the answer to "did that work?" was a panel that looked identical either
  // way, and the app only revealed the balance after a full review — which also
  // spends a model call to answer a question that is pure arithmetic.
  //
  // Failure here is not failure of the status call: the connection can be fine
  // while the balance read is not, and saying "not connected" for that would
  // send someone to re-paste a token that was never the problem.
  let holdings: { symbol: string; qty: number }[] | null = null;
  let holdingsError: string | null = null;

  if (discovery?.capabilities.balances) {
    try {
      const raw = await callTool(discovery.capabilities.balances, {});
      holdings = parseBalances(raw, "USDT")
        .filter((h) => h.qty > 0)
        .map((h) => ({ symbol: h.symbol, qty: h.qty }));
    } catch (err) {
      holdingsError = err instanceof Error ? err.message : "Could not read balances.";
    }
  }

  return NextResponse.json({
    connected: !(error && error.includes("connect again")),
    endpoint: MCP_ENDPOINT,
    oauthAvailable: Boolean(clientId()),
    via: token.via,
    expiresAt: token.expiresAt,
    error,
    tools: discovery?.tools.map((t) => ({ name: t.name, description: t.description })) ?? [],
    capabilities: discovery?.capabilities ?? null,
    discoveredAt: discovery?.discoveredAt ?? null,
    holdings,
    holdingsError,
  });
}

/** DELETE — drop the token, in this process and in the browser. */
export async function DELETE() {
  const { clearToken } = await import("@/server/mcp-session");
  const { forgetDiscovery } = await import("@/server/mcp-client");
  const { COOKIE } = await import("@/server/sealed");
  clearToken();
  forgetDiscovery();
  const res = NextResponse.json({ connected: false });
  res.cookies.delete(COOKIE.token);
  return res;
}
