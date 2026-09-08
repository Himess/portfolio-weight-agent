/**
 * Two things every route needs once this is reachable from the internet.
 *
 * 1. Recover the Binance token from the request cookie. On serverless the
 *    module-level copy belongs to whichever instance happened to serve the
 *    OAuth callback; the durable one travels with the browser.
 *
 * 2. Rate limiting. A public URL means anyone who finds it can spend the
 *    owner's LLM quota and their share of Binance's rate limit. The expensive
 *    routes are capped per client.
 *
 * The limiter is per-instance and in-memory, which on serverless means the real
 * ceiling is (limit x instances) rather than (limit). That is a genuine
 * weakness and the reason the numbers below are conservative — it is a brake on
 * casual abuse, not a security control. A shared store would fix it properly
 * and is the right move if this ever has real users.
 */

import { NextResponse } from "next/server";

import { TtlCache } from "../lib/cache";
import { adoptToken, type McpToken } from "./mcp-session";
import { COOKIE, unseal } from "./sealed";

// ---------------------------------------------------------------------------
// Session recovery
// ---------------------------------------------------------------------------

export function restoreSession(req: Request): void {
  const cookie = req.headers.get("cookie");
  const match = cookie?.match(new RegExp(`${COOKIE.token}=([^;]+)`));
  // Adopt unconditionally, including the no-cookie case. Returning early here
  // left the previous caller's token in the module global, which on serverless
  // is shared with every other request the instance serves.
  adoptToken(match ? unseal<McpToken>(match[1]) : null);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

type Window = { count: number; resetAt: number };

// Bounded, so a flood of distinct clients cannot grow this without limit.
const windows = new TtlCache<Window>({ ttlMs: 10 * 60_000, max: 5_000 });

export type Limit = { limit: number; windowMs: number };

/** Costs an LLM call and several Binance calls; the tightest budget. */
export const REVIEW_LIMIT: Limit = { limit: 10, windowMs: 60_000 };
/** One LLM call. */
export const BASKET_LIMIT: Limit = { limit: 12, windowMs: 60_000 };
/** Cheap and cached, but still fans out to Binance. */
export const MARKET_LIMIT: Limit = { limit: 120, windowMs: 60_000 };

/**
 * Identify the caller. Behind Vercel the client address is in x-forwarded-for;
 * the first entry is the client, the rest are proxies. Falls back to a shared
 * bucket, which is deliberately strict rather than permissive: an unidentifiable
 * caller shares one budget instead of getting an unlimited one.
 */
function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "anonymous";
}

export function rateLimit(req: Request, route: string, limit: Limit): NextResponse | null {
  const key = `${route}:${clientKey(req)}`;
  const now = Date.now();

  const current = windows.get(key);
  if (!current || now >= current.resetAt) {
    windows.set(key, { count: 1, resetAt: now + limit.windowMs });
    return null;
  }

  if (current.count >= limit.limit) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    return NextResponse.json(
      {
        error: `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}. Nothing was sent.`,
        code: "rate_limited",
        retryable: true,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  current.count++;
  windows.set(key, current);
  return null;
}
