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
 * Map a thrown error onto a status the client can act on.
 *
 * Every message here ends up in front of a user, so it says what happened and
 * what to do — and, for anything that touches trading, that nothing was sent.
 */
export function failure(err: unknown, context: string): NextResponse<ApiError> {
  if (err instanceof ZodError) {
    return badRequest(firstIssue(err));
  }

  if (err instanceof TimeoutError) {
    return NextResponse.json(
      {
        error: `${context} timed out waiting for Binance. Nothing was sent. Try again in a moment.`,
        code: "upstream_timeout" as const,
        retryable: true,
      },
      { status: 504 },
    );
  }

  if (err instanceof HttpError) {
    if (err.status === 429) {
      return NextResponse.json(
        {
          error: `Binance is rate-limiting requests right now. Nothing was sent. Wait a minute and try again.`,
          code: "rate_limited" as const,
          retryable: true,
        },
        { status: 429 },
      );
    }
    return NextResponse.json(
      {
        error: `${context} failed: Binance returned HTTP ${err.status}. Nothing was sent.`,
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
      error: `${context} failed. Nothing was sent to Binance.`,
      code: "internal" as const,
      retryable: false,
    },
    { status: 500 },
  );
}
