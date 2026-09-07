import { NextResponse } from "next/server";

import { appUrl } from "@/server/app-url";
import { failure } from "@/server/respond";
import { deleteWebhook, getMe, getWebhookInfo, setWebhook, telegramConfigured } from "@/server/telegram";
import { describeStore } from "@/server/watch-store";

export const runtime = "nodejs";

/**
 * Point Telegram at this deployment, and report whether it worked.
 *
 * Registering a webhook is a one-time act per deployment URL, and doing it by
 * hand means pasting a bot token into a curl command — which is how bot tokens
 * end up in shell history. This route does it server-side using the token
 * already in the environment, and never returns it.
 *
 * Guarded by CRON_SECRET: whoever can schedule the scan can also wire the bot,
 * and nobody else can repoint someone's bot at a URL of their choosing.
 */
function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  return new URL(req.url).searchParams.get("key") === secret;
}

export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  if (!telegramConfigured()) {
    return NextResponse.json({ configured: false, reason: "TELEGRAM_BOT_TOKEN is not set." });
  }

  // `?register=1` does the POST's job from a browser address bar. Not pure
  // REST, and deliberate: the alternative is telling someone to run a curl
  // command with a bot token in it, which is how bot tokens end up in shell
  // history. It is behind the same secret as everything else here.
  if (new URL(req.url).searchParams.get("register") === "1") return POST(req);

  try {
    const [me, hook] = await Promise.all([getMe(), getWebhookInfo()]);
    return NextResponse.json({
      configured: true,
      bot: `@${me.username}`,
      webhook: hook.url || null,
      pending: hook.pending_update_count,
      lastError: hook.last_error_message ?? null,
      expected: `${appUrl(req)}/api/telegram/webhook`,
      cronConfigured: Boolean(process.env.CRON_SECRET),
      store: describeStore(),
    });
  } catch (err) {
    return failure(err, "Reading the Telegram setup");
  }
}

export async function POST(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: "Not authorised." }, { status: 401 });

  try {
    const url = `${appUrl(req)}/api/telegram/webhook`;
    await setWebhook(url);
    const me = await getMe();
    return NextResponse.json({ ok: true, bot: `@${me.username}`, webhook: url });
  } catch (err) {
    return failure(err, "Registering the Telegram webhook");
  }
}

export async function DELETE(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  try {
    await deleteWebhook();
    return NextResponse.json({ ok: true, webhook: null });
  } catch (err) {
    return failure(err, "Removing the Telegram webhook");
  }
}
