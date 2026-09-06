import { NextResponse } from "next/server";

import { buildAuthorizeUrl } from "@/server/mcp-session";

export const runtime = "nodejs";

/**
 * GET — begin the authorization-code + PKCE flow and redirect to Binance.
 *
 * The redirect URI is derived from the request rather than configured, so this
 * works unchanged on localhost and on a deployment without a second setting to
 * keep in sync.
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const redirectUri = `${origin}/api/mcp/auth/callback`;

  try {
    const { url } = await buildAuthorizeUrl(redirectUri);
    return NextResponse.redirect(url);
  } catch (err) {
    // Failing here is expected until the app is deployed with a client-metadata
    // URL, so say what to do instead rather than only what went wrong.
    return NextResponse.redirect(
      `${origin}/?mcp_error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`,
    );
  }
}
