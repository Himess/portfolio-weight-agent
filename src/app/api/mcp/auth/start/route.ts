import { NextResponse } from "next/server";

import { buildAuthorizeUrl } from "@/server/mcp-session";
import { COOKIE, cookieOptions, seal } from "@/server/sealed";

export const runtime = "nodejs";

/**
 * GET — begin the authorization-code + PKCE flow and redirect to Binance.
 *
 * The verifier travels back to the callback in a sealed httpOnly cookie rather
 * than in server memory: on serverless the callback may be a different
 * instance, and a verifier it cannot find is an authorization it cannot
 * complete.
 *
 * The redirect URI is derived from the request, so this works unchanged on
 * localhost and on a deployment without a second setting to keep in sync.
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const redirectUri = `${origin}/api/mcp/auth/callback`;

  try {
    const { url, state, verifier } = await buildAuthorizeUrl(redirectUri);

    const res = NextResponse.redirect(url);
    res.cookies.set(
      COOKIE.pkce,
      seal({ state, verifier, redirectUri }, 10 * 60_000),
      cookieOptions(600, origin.startsWith("https://")),
    );
    return res;
  } catch (err) {
    // Expected until the app is deployed with a client-metadata URL, so say
    // what to do instead rather than only what went wrong.
    return NextResponse.redirect(
      `${origin}/?mcp_error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`,
    );
  }
}
