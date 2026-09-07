/**
 * Confirms what the app will actually be able to do with this environment:
 * which LLM provider it resolves, and whether standing alerts are wired.
 * Secrets are printed masked, never in full.
 */

import { resolveProvider } from "../src/llm/provider";
import { describeStore } from "../src/server/watch-store";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "LLM_API_KEY",
];

function mask(v: string): string {
  if (v.length <= 12) return `${v.slice(0, 3)}…(${v.length} chars)`;
  return `${v.slice(0, 8)}…${v.slice(-4)} (${v.length} chars)`;
}

console.log("Keys visible to the app:");
let any = false;
for (const k of KEYS) {
  const v = process.env[k];
  if (v) {
    any = true;
    console.log(`  ${k.padEnd(20)} ${mask(v)}`);
  }
}
if (!any) console.log("  (none)");

const p = resolveProvider();
console.log(`\nResolved provider: ${p.label}`);

if (p.kind === "none") {
  console.log(
    "\nThe app still runs — every deterministic figure is computed as normal and the\n" +
      "agent falls back to the plain band rule, labelled as such in the UI.\n" +
      "\nTo turn the judgment layer on, put ONE of these in .env:\n" +
      "  GEMINI_API_KEY=...       free tier, no card — https://aistudio.google.com/apikey\n" +
      "  GROQ_API_KEY=...         free tier          — https://console.groq.com/keys\n" +
      "  OPENROUTER_API_KEY=...                      — https://openrouter.ai/keys\n" +
      "  ANTHROPIC_API_KEY=...    paid               — https://console.anthropic.com/settings/keys\n" +
      "\nThen: npm run llm:check",
  );
} else {
  console.log(`  kind    ${p.kind}`);
  console.log(`  model   ${p.model}`);
  if (p.baseUrl) console.log(`  baseUrl ${p.baseUrl}`);
  console.log("\nNext: npm run llm:check -- --n 10");
}

// ---------------------------------------------------------------------------
// Standing alerts
// ---------------------------------------------------------------------------

console.log("\nTelegram alerts:");
const bot = process.env.TELEGRAM_BOT_TOKEN;
const cron = process.env.CRON_SECRET;

if (!bot) {
  console.log("  off — TELEGRAM_BOT_TOKEN is not set");
  console.log("  Create a bot with @BotFather, then follow docs/telegram-alerts.md");
} else {
  console.log(`  TELEGRAM_BOT_TOKEN   ${mask(bot)}`);
  console.log(
    cron
      ? `  CRON_SECRET          ${mask(cron)}`
      : "  CRON_SECRET          MISSING — the scan and the setup route both refuse without it",
  );
  console.log(
    process.env.AUTH_SECRET
      ? "  AUTH_SECRET          set — the webhook secret derives from it"
      : "  AUTH_SECRET          missing — fine locally, required in production",
  );

  const store = describeStore();
  console.log(`  watch store          ${store.kind}${store.durable ? "" : "   <-- NOT durable"}`);
  console.log(`                       ${store.note}`);
}
