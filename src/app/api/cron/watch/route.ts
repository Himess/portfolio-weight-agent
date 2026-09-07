import { NextResponse } from "next/server";

import { failure } from "@/server/respond";
import { runScan } from "@/server/watch-run";

export const runtime = "nodejs";
// A scan prices every watch and may run a review for each breach. The default
// 300s is enough for the caps in watch-run.ts.
export const maxDuration = 300;

/**
 * The scheduled scan.
 *
 * Anything that can fetch a URL on a schedule drives this: Vercel Cron (which
 * sends `Authorization: Bearer $CRON_SECRET`), a GitHub Action, cron-job.org, a
 * phone shortcut. Hourly is the intended cadence and the quiet window in
 * watch-run.ts is what keeps that from being noisy.
 *
 * It is not public. Without a secret, an open endpoint would let anyone drain
 * the deployment's LLM quota by hitting it in a loop.
 */
function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  // No secret configured means the scan is disabled rather than open. A
  // scheduler that cannot authenticate should fail loudly at setup time, not
  // leave a public endpoint that spends money.
  if (!secret) return false;

  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;

  // Some schedulers only take a URL. Supported, but second-best: a secret in a
  // query string ends up in access logs.
  return new URL(req.url).searchParams.get("key") === secret;
}

async function handle(req: Request) {
  if (!authorised(req)) {
    return NextResponse.json(
      { error: "Not authorised. Set CRON_SECRET and send it as `Authorization: Bearer <secret>`." },
      { status: 401 },
    );
  }

  try {
    const started = Date.now();
    const result = await runScan();
    return NextResponse.json({
      ...result,
      // Enough to debug a quiet scan from the scheduler's own log, without
      // repeating anything about the portfolios themselves.
      outcomes: result.outcomes.map((o) => ({
        verdict: o.verdict,
        breached: o.breached.length,
        sent: o.sent,
        why: o.why,
        ...(o.error ? { error: o.error } : {}),
      })),
      tookMs: Date.now() - started,
    });
  } catch (err) {
    return failure(err, "The scheduled scan");
  }
}

export const GET = handle;
export const POST = handle;
