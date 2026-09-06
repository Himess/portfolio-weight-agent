/**
 * Confirms which LLM provider the app will actually use, and that the key is
 * being loaded from .env. Keys are printed masked, never in full.
 */

import { resolveProvider } from "../src/llm/provider";

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
  process.exit(0);
}

console.log(`  kind    ${p.kind}`);
console.log(`  model   ${p.model}`);
if (p.baseUrl) console.log(`  baseUrl ${p.baseUrl}`);
console.log("\nNext: npm run llm:check -- --n 10");
