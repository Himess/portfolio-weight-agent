import { NextResponse } from "next/server";

import { forgetDiscovery } from "@/server/mcp-client";
import { consumePending, exchangeCode, setToken } from "@/server/mcp-session";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET — Binance returns here with ?code&state.
 *
 * The state is consumed exactly once and compared in constant time; a replayed
 * or forged callback finds nothing pending and is refused. The code is then
 * exchanged server-side with the PKCE verifier, and the token never reaches the
 * browser.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const back = (params: Record<string, string>) =>
    NextResponse.redirect(`${origin}/?${new URLSearchParams(params).toString()}`);

  if (oauthError) {
    return back({
      mcp_error: url.searchParams.get("error_description") ?? oauthError,
    });
  }
  if (!code || !state) {
    return back({ mcp_error: "Binance returned no authorization code." });
  }

  const pending = consumePending(state);
  if (!pending) {
    return back({
      mcp_error: "That sign-in link has expired or was already used. Start again.",
    });
  }

  try {
    const token = await exchangeCode(code, pending.verifier, pending.redirectUri);
    setToken(token);
    forgetDiscovery();
    return back({ mcp_connected: "1" });
  } catch (err) {
    return back({ mcp_error: err instanceof Error ? err.message : String(err) });
  }
}
