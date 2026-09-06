/**
 * Anthropic client and model configuration.
 *
 * DESIGN.md §7 specifies claude-sonnet-4-6 with temperature 0.2 for the
 * analytical decisions and 0.7 for the narrative. That is the default here.
 *
 * The model is swappable via ANTHROPIC_MODEL. One caveat is handled for you:
 * `temperature` was removed on Opus 5 / Sonnet 5 and returns a 400 there, so
 * we only send sampling parameters to models that accept them. Switching to
 * `claude-opus-5` therefore needs no other code change.
 */

import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

/** Temperature is rejected (400) on the Opus 5 / Sonnet 5 generation. */
export function supportsTemperature(model: string): boolean {
  return !/^claude-(opus-5|sonnet-5|fable-5|mythos-5)/.test(model);
}

export type Temp = "analytical" | "creative";

/** Sampling params, omitted entirely on models that reject them. */
export function samplingFor(kind: Temp, model = MODEL): { temperature?: number } {
  if (!supportsTemperature(model)) return {};
  return { temperature: kind === "analytical" ? 0.2 : 0.7 };
}

let cached: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!cached) cached = new Anthropic();
  return cached;
}

/** True when a credential is available; the app degrades to deterministic-only without one. */
export function hasCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Structured log line for every LLM decision — schema failures must be visible. */
export function logDecision(
  decision: string,
  outcome: "ok" | "fallback",
  detail?: string,
): void {
  const line = `[llm] ${decision} -> ${outcome}${detail ? `: ${detail}` : ""}`;
  if (outcome === "fallback") console.warn(line);
  else console.log(line);
}
