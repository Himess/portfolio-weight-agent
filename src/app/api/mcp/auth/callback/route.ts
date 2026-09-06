import { NextResponse } from "next/server";

import { forgetDiscovery } from "@/server/mcp-client";
import { exchangeCode, statesMatch } from "@/server/mcp-session";
import { COOKIE, cookieOptions, seal, unseal } from "@/server/sealed";

export const runtime = "nodejs";
export const maxDuration = 60;

type Pkce = { state: string; verifier: string; redirectUri: string };

/**
 * GET — Binance returns here with ?code&state.
 *
 * The state is compared in constant time against the one sealed into the
 * cookie at the start of the flow, and the cookie is cleared whatever happens,
 * so a replayed callback finds nothing to work with. The code is exchanged
 * server-side and the resulting token never reaches page scripts.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;
  const secure = origin.startsWith("https://");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const back = (params: Record<string, string>) => {
    const res = NextResponse.redirect(`${origin}/?${new URLSearchParams(params).toString()}`);
    res.cookies.delete(COOKIE.pkce);
    return res;
  };

  if (oauthError) {
    return back({ mcp_error: url.searchParams.get("error_description") ?? oauthError });
  }
  if (!code || !state) {
    return back({ mcp_error: "Binance returned no authorization code." });
  }

  const pending = unseal<Pkce>(req.headers.get("cookie")?.match(/pwa_pkce=([^;]+)/)?.[1]);
  if (!pending || !statesMatch(pending.state, state)) {
    return back({ mcp_error: "That sign-in link has expired or was already used. Start again." });
  }

  try {
    const token = await exchangeCode(code, pending.verifier, pending.redirectUri);
    forgetDiscovery();

    const res = back({ mcp_connected: "1" });
    // Live as long as the token says, capped at a week; a token with no stated
    // lifetime gets a day rather than forever.
    const ttlMs = token.expiresAt ? Math.max(60_000, token.expiresAt - Date.now()) : 86_400_000;
    res.cookies.set(
      COOKIE.token,
      seal(token, Math.min(ttlMs, 7 * 86_400_000)),
      cookieOptions(Math.floor(Math.min(ttlMs, 7 * 86_400_000) / 1000), secure),
    );
    return res;
  } catch (err) {
    return back({ mcp_error: err instanceof Error ? err.message : String(err) });
  }
}
