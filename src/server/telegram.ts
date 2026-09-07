/**
 * Telegram Bot API — the only outbound channel this app has.
 *
 * Deliberately thin. Everything the bot says is composed by the caller from
 * numbers the deterministic core produced; this file does transport and
 * escaping, nothing else.
 *
 * The bot token is a server secret. It never reaches the browser, and no route
 * echoes it back — a leaked bot token lets anyone post as the bot to every chat
 * that ever started it.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { fetchJson, HttpError } from "../lib/http";

const API = "https://api.telegram.org";

export function botToken(): string | null {
  const t = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return t && t.length > 0 ? t : null;
}

export function telegramConfigured(): boolean {
  return botToken() !== null;
}

/**
 * The secret Telegram must echo back on every webhook call.
 *
 * Without it, anyone who guesses the webhook URL can post updates that look
 * like they came from Telegram and drive the bot. There is deliberately no
 * "unset" case: an explicit TELEGRAM_WEBHOOK_SECRET wins, and otherwise one is
 * derived from AUTH_SECRET, which a production deployment must already have.
 * A secret nobody remembered to configure is the one that gets skipped.
 */
export function webhookSecret(): string {
  const explicit = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (explicit) return explicit;

  const base = process.env.AUTH_SECRET ?? "development-only-insecure-key";
  // Telegram accepts A-Za-z0-9_- up to 256 chars.
  return createHash("sha256").update(`${base}:telegram-webhook`).digest("base64url");
}

/** Constant-time compare, so a wrong secret cannot be found byte by byte. */
export function webhookSecretMatches(candidate: string | null): boolean {
  const expected = Buffer.from(webhookSecret());
  const given = Buffer.from(candidate ?? "");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

type TgResponse<T> = { ok: boolean; result: T; description?: string };

async function call<T>(method: string, payload: unknown): Promise<T> {
  const token = botToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set.");

  const res = await fetchJson<TgResponse<T>>(`${API}/bot${token}/${method}`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    timeoutMs: 12_000,
  });
  if (!res.ok) throw new Error(`Telegram ${method} failed: ${res.description ?? "unknown"}`);
  return res.result;
}

// Escaping lives with the message composer, which is where interpolation
// happens; re-exported here so transport callers do not have to know that.
export { esc } from "../lib/watch-message";

export type SendResult = { ok: true; messageId: number } | { ok: false; error: string; blocked: boolean };

export type InlineButton = { text: string; url: string };

/**
 * Send one message. Never throws: a watcher scanning many chats must not lose
 * the whole run because one user blocked the bot.
 */
export async function sendMessage(
  chatId: number,
  html: string,
  buttons: InlineButton[] = [],
): Promise<SendResult> {
  try {
    const result = await call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(buttons.length > 0
        ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, url: b.url }))] } }
        : {}),
    });
    return { ok: true, messageId: result.message_id };
  } catch (err) {
    // 403 means the user blocked the bot or deleted the chat. That is a
    // permanent condition, and the caller should stop trying rather than retry
    // it every hour forever.
    const blocked = err instanceof HttpError && err.status === 403;
    return { ok: false, error: err instanceof Error ? err.message : String(err), blocked };
  }
}

export type BotIdentity = { id: number; username: string };

export async function getMe(): Promise<BotIdentity> {
  const me = await call<{ id: number; username: string }>("getMe", {});
  return { id: me.id, username: me.username };
}

/** Point Telegram at this deployment. Idempotent; safe to call on every setup run. */
export async function setWebhook(url: string): Promise<void> {
  await call("setWebhook", {
    url,
    secret_token: webhookSecret(),
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
}

export async function deleteWebhook(): Promise<void> {
  await call("deleteWebhook", { drop_pending_updates: true });
}

export async function getWebhookInfo(): Promise<{ url: string; pending_update_count: number; last_error_message?: string }> {
  return call("getWebhookInfo", {});
}
