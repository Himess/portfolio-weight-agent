/**
 * One error shape for the whole API, and one place that decides the status.
 *
 * Handlers were each inventing their own: some returned `{error}` with 400,
 * some with 500, and an upstream timeout surfaced as an opaque 500 that told
 * the client nothing it could act on. A client cannot handle failures it cannot
 * distinguish.
 */

import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { HttpError, TimeoutError } from "../lib/http";
import { firstIssue } from "../lib/api-contracts";

export type ApiError = {
  error: string;
  /** Stable machine-readable code — the client branches on this, not the prose. */
  code:
    | "bad_request"
    | "upstream_unavailable"
    | "upstream_timeout"
    | "rate_limited"
    | "not_connected"
    | "internal";
  /** Whether trying the same request again could plausibly work */
  retryable: boolean;
};

export function badRequest(message: string): NextResponse<ApiError> {
  return NextResponse.json({ error: message, code: "bad_request", retryable: false }, { status: 400 });
}

/**
 * Which upstream actually failed.
 *
 * Everything used to be reported as Binance, which was true when Binance was
 * the only upstream. It is not any more: a Telegram 401 announced as "Binance
 * returned HTTP 401" sends someone to check the wrong credential entirely.
 * The error carries its URL, so the message can simply say who answered.
 */
function upstreamName(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "the upstream service";
  }
  if (host.endsWith("telegram.org")) return "Telegram";
  if (host.includes("binance")) return "Binance";
  if (host.includes("googleapis") || host.includes("anthropic") || host.includes("openai")) {
    return "the model provider";
  }
  if (host.includes("upstash")) return "the watch store";
  return host;
}

/**
 * Map a thrown error onto a status the client can act on.
 *
 * Every message here ends up in front of a user, so it says what happened, who
 * it happened with, and what to do. "No order was placed" is stated rather than
 * implied: this app never places one directly, and a user reading an error
 * about their portfolio should not have to wonder.
 */
export function failure(err: unknown, context: string): NextResponse<ApiError> {
  if (err instanceof ZodError) {
    return badRequest(firstIssue(err));
  }

  if (err instanceof TimeoutError) {
    return NextResponse.json(
      {
        error: `${context} timed out waiting for ${upstreamName(err.url)}. No order was placed. Try again in a moment.`,
        code: "upstream_timeout" as const,
        retryable: true,
      },
      { status: 504 },
    );
  }

  if (err instanceof HttpError) {
    const who = upstreamName(err.url);
    if (err.status === 429) {
      return NextResponse.json(
        {
          error: `${who} is rate-limiting requests right now. No order was placed. Wait a minute and try again.`,
          code: "rate_limited" as const,
          retryable: true,
        },
        { status: 429 },
      );
    }
    return NextResponse.json(
      {
        error: `${context} failed: ${who} returned HTTP ${err.status}. No order was placed.`,
        code: "upstream_unavailable" as const,
        retryable: err.status >= 500,
      },
      { status: 502 },
    );
  }

  const message = err instanceof Error ? err.message : String(err);

  if (/not connected|connect again/i.test(message)) {
    return NextResponse.json(
      { error: message, code: "not_connected" as const, retryable: false },
      { status: 401 },
    );
  }

  // Log the real thing; return something a user can read.
  console.error(`[api] ${context}:`, err);
  return NextResponse.json(
    {
      error: `${context} failed. No order was placed.`,
      code: "internal" as const,
      retryable: false,
    },
    { status: 500 },
  );
}
