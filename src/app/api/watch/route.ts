import { NextResponse } from "next/server";

import { WatchIdSchema, WatchRequestSchema } from "@/lib/api-contracts";
import { rateLimit, type Limit } from "@/server/guard";
import { badRequest, failure } from "@/server/respond";
import { getMe, telegramConfigured } from "@/server/telegram";
import { describeStore, newWatchId, watchStore, type WatchRecord } from "@/server/watch-store";

export const runtime = "nodejs";

/** Registering a watch is cheap, but it writes; keep it modest. */
const WATCH_LIMIT: Limit = { limit: 20, windowMs: 60_000 };

/**
 * A watch is a standing question: "tell me when this allocation needs a
 * decision." Creating one stores the allocation and the holdings, and returns a
 * Telegram deep link. Nothing is sent anywhere until the user opens that link
 * and presses Start — the app cannot message a chat that has not opted in, and
 * that is Telegram's rule, not a policy this app could relax.
 */
export async function POST(req: Request) {
  const limited = rateLimit(req, "watch", WATCH_LIMIT);
  if (limited) return limited;

  try {
    if (!telegramConfigured()) {
      return badRequest(
        "Telegram is not configured on this deployment. Set TELEGRAM_BOT_TOKEN to enable watches.",
      );
    }

    const body = WatchRequestSchema.parse(await req.json());

    // Resolve the bot before storing anything. Doing it afterwards left an
    // orphaned record behind every time the token was wrong.
    const me = await getMe();

    const record: WatchRecord = {
      id: newWatchId(),
      chatId: null,
      createdAt: new Date().toISOString(),
      boundAt: null,
      label: body.label,
      allocation: body.allocation,
      quantities: body.quantities,
      preference: body.preference,
      paused: false,
      repeatAfterHours: body.repeatAfterHours,
      lastCheckedAt: null,
      lastNotifiedAt: null,
      lastSignature: null,
      lastVerdict: null,
    };

    await watchStore().put(record);

    return NextResponse.json({
      id: record.id,
      botUsername: me.username,
      // Telegram passes the payload to the bot as `/start <payload>`, which is
      // how the chat id gets bound without the user typing anything.
      deepLink: `https://t.me/${me.username}?start=${record.id}`,
      store: describeStore(),
    });
  } catch (err) {
    return failure(err, "Creating the watch");
  }
}

/** Poll after opening the deep link, to know when the chat has bound. */
export async function GET(req: Request) {
  try {
    const id = WatchIdSchema.parse(new URL(req.url).searchParams.get("id") ?? "");
    const watch = await watchStore().get(id);
    if (!watch) return NextResponse.json({ found: false });

    // The link is regenerated rather than stored: a watch remembered from an
    // earlier session must still be openable, and the id is already in the
    // caller's hands.
    const me = watch.chatId == null ? await getMe().catch(() => null) : null;

    // The chat id is not returned. It identifies a Telegram account, the
    // browser has no use for it, and anything handed to the page is public.
    return NextResponse.json({
      found: true,
      bound: watch.chatId != null,
      paused: watch.paused,
      label: watch.label,
      repeatAfterHours: watch.repeatAfterHours,
      lastCheckedAt: watch.lastCheckedAt,
      lastNotifiedAt: watch.lastNotifiedAt,
      lastVerdict: watch.lastVerdict,
      ...(me ? { botUsername: me.username, deepLink: `https://t.me/${me.username}?start=${watch.id}` } : {}),
    });
  } catch (err) {
    return failure(err, "Reading the watch");
  }
}

export async function DELETE(req: Request) {
  const limited = rateLimit(req, "watch", WATCH_LIMIT);
  if (limited) return limited;

  try {
    const id = WatchIdSchema.parse(new URL(req.url).searchParams.get("id") ?? "");
    await watchStore().remove(id);
    return NextResponse.json({ removed: true });
  } catch (err) {
    return failure(err, "Removing the watch");
  }
}
