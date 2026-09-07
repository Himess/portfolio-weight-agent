import { NextResponse } from "next/server";

import { WatchIdSchema } from "@/lib/api-contracts";
import { esc, sendMessage, telegramConfigured, webhookSecretMatches } from "@/server/telegram";
import { checkNow } from "@/server/watch-run";
import { watchStore, type WatchRecord } from "@/server/watch-store";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The bot's inbox.
 *
 * Two things matter here.
 *
 * First, authenticity. Telegram echoes a secret header on every delivery; a
 * request without the right one is not from Telegram, and is refused before
 * anything is read. The URL alone is not a credential.
 *
 * Second, trust boundary. Everything in an update is written by whoever is
 * typing into the chat. It is parsed as a fixed set of commands and never
 * reaches the model, and no command can move money — the strongest thing a
 * chat can do is unsubscribe itself. Approving a trade stays in the app, in
 * front of a person who can see the numbers.
 */

type Update = {
  message?: {
    chat?: { id?: number };
    text?: string;
    from?: { id?: number; is_bot?: boolean };
  };
};

const HELP = [
  "This bot watches one target allocation and messages you when it needs a decision.",
  "",
  "<b>/status</b> — what the agent last concluded",
  "<b>/check</b> — check right now",
  "<b>/pause</b> and <b>/resume</b> — stop and restart the alerts",
  "<b>/stop</b> — unlink this chat",
  "",
  "It can only send you messages. It cannot place, cancel or approve an order.",
].join("\n");

function summarise(watch: WatchRecord): string {
  const lines = [
    `<b>${esc(watch.label ?? "Your allocation")}</b>`,
    "",
    `Tracking: ${esc(watch.preference)}`,
    `Alerts: ${watch.paused ? "paused" : "on"}`,
    `Repeats an unchanged verdict every ${watch.repeatAfterHours}h`,
  ];
  lines.push(
    watch.lastCheckedAt
      ? `Last checked: ${esc(new Date(watch.lastCheckedAt).toUTCString())}`
      : "Not checked yet",
  );
  if (watch.lastVerdict) lines.push(`Last verdict: ${esc(watch.lastVerdict)}`);
  return lines.join("\n");
}

export async function POST(req: Request) {
  // Refuse anything that cannot prove it came from Telegram, and say nothing
  // about why — an error that distinguishes "wrong secret" from "no watch" is
  // a probing tool.
  if (!webhookSecretMatches(req.headers.get("x-telegram-bot-api-secret-token"))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  if (!telegramConfigured()) return NextResponse.json({ ok: true });

  let update: Update;
  try {
    update = (await req.json()) as Update;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const chatId = update.message?.chat?.id;
  const text = (update.message?.text ?? "").trim();
  // Telegram always answers 200 to a webhook; a non-200 makes it retry the same
  // update for hours. Anything unusable is acknowledged and dropped.
  if (typeof chatId !== "number" || text.length === 0) return NextResponse.json({ ok: true });
  if (update.message?.from?.is_bot) return NextResponse.json({ ok: true });

  const store = watchStore();
  const [rawCommand, payload] = text.split(/\s+/, 2);
  // Group chats address commands as /status@BotName.
  const command = rawCommand.toLowerCase().split("@")[0];

  try {
    if (command === "/start") {
      const parsed = WatchIdSchema.safeParse(payload ?? "");
      if (!parsed.success) {
        await sendMessage(chatId, HELP);
        return NextResponse.json({ ok: true });
      }

      const watch = await store.get(parsed.data);
      if (!watch) {
        await sendMessage(
          chatId,
          "That link has expired or was already removed. Create a new watch in the app.",
        );
        return NextResponse.json({ ok: true });
      }

      // Binding a watch that already points at another chat moves it here
      // rather than fanning out: one watch, one chat, and the person holding
      // the link is the one who created it.
      const previous = await store.byChat(chatId);
      if (previous && previous.id !== watch.id) {
        await store.put({ ...previous, chatId: null, boundAt: null });
      }

      await store.put({ ...watch, chatId, boundAt: new Date().toISOString(), paused: false });
      await sendMessage(
        chatId,
        [
          `<b>Watching ${esc(watch.label ?? "your allocation")}</b>`,
          "",
          "You will hear from the agent when a position leaves its band — and what it decided to do about it, including deciding to wait.",
          "",
          "Nothing else will arrive. No daily summary, no price alerts.",
          "",
          HELP,
        ].join("\n"),
      );
      return NextResponse.json({ ok: true });
    }

    const watch = await store.byChat(chatId);
    if (!watch) {
      await sendMessage(chatId, ["No allocation is linked to this chat.", "", HELP].join("\n"));
      return NextResponse.json({ ok: true });
    }

    switch (command) {
      case "/status":
        await sendMessage(chatId, summarise(watch));
        break;

      case "/pause":
        await store.put({ ...watch, paused: true });
        await sendMessage(chatId, "Paused. Nothing will be sent until you /resume.");
        break;

      case "/resume":
        await store.put({ ...watch, paused: false });
        await sendMessage(chatId, "Resumed. You will hear from the agent on the next breach.");
        break;

      case "/stop":
        await store.put({ ...watch, chatId: null, boundAt: null, paused: true });
        await sendMessage(
          chatId,
          "Unlinked. Your allocation is untouched — open the app to start a new watch.",
        );
        break;

      case "/check": {
        // Bypasses the quiet window on purpose: the user asked, so the answer
        // goes out even if the same verdict was sent an hour ago.
        const outcome = await checkNow({ ...watch, lastSignature: null, lastNotifiedAt: null });
        if (!outcome.sent) {
          await sendMessage(
            chatId,
            `Everything is inside its band. Total drift is ${outcome.totalDriftPp.toFixed(1)}pp — nothing worth acting on.`,
          );
        }
        break;
      }

      default:
        await sendMessage(chatId, HELP);
    }
  } catch (err) {
    // A failure here must not make Telegram redeliver the same command.
    console.error("[telegram] webhook failed", err);
    await sendMessage(chatId, "Something went wrong handling that. Try again in a moment.");
  }

  return NextResponse.json({ ok: true });
}
