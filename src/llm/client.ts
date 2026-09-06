/**
 * Anthropic client construction and shared logging.
 *
 * Provider selection lives in provider.ts — this module only knows how to build
 * an Anthropic client when that is the chosen backend. Keeping it separate
 * avoids a circular import, since provider.ts consumes this.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * `temperature` was removed on the Opus 5 / Sonnet 5 generation and returns a
 * 400 there, so sampling parameters are only sent to models that accept them.
 * This is what makes ANTHROPIC_MODEL swappable without any other change.
 */
export function supportsTemperature(model: string): boolean {
  return !/^claude-(opus-5|sonnet-5|fable-5|mythos-5)/.test(model);
}

let cached: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!cached) cached = new Anthropic();
  return cached;
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
