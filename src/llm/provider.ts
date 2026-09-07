/**
 * Provider-agnostic structured calls.
 *
 * All four decisions (DESIGN.md §7) have the same shape: a system prompt plus a
 * block of precomputed JSON facts go in, and JSON conforming to a strict schema
 * comes out. Nothing about that requires a specific vendor, so this module is
 * the only place a vendor is named.
 *
 * Two backends:
 *   anthropic      — messages.parse() + zodOutputFormat
 *   openai-compat  — POST /chat/completions with a JSON-schema response format
 *
 * The second one covers Google Gemini (via its OpenAI-compatible endpoint),
 * Groq, OpenRouter, Cerebras and a local Ollama — i.e. every free option — so
 * the project can be run and judged without anyone paying for a key.
 *
 * Whatever the backend returns is validated against the zod schema here. A
 * provider that ignores the schema, returns prose, or wraps the JSON in a code
 * fence fails validation and the caller falls back to its deterministic default.
 * That is the same guarantee as before, now independent of vendor.
 */

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import { z } from "zod";

import { getClient, supportsTemperature } from "./client";

export type ProviderKind = "anthropic" | "openai-compat" | "none";

export type ProviderConfig = {
  kind: ProviderKind;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Shown in the UI so it is always clear what produced the judgment */
  label: string;
  /**
   * Provider-specific request fields. Kept per-preset because OpenAI-compatible
   * endpoints agree on the core shape but not the extensions — sending Gemini's
   * knobs to Groq would be rejected.
   */
  extraBody?: Record<string, unknown>;
};

type Preset = {
  baseUrl: string;
  model: string;
  label: string;
  envKey: string;
  extraBody?: Record<string, unknown>;
};

/** Known OpenAI-compatible endpoints, so the common cases need one env var. */
const PRESETS: Record<string, Preset> = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    // Free-tier quota is per model per day, and it varies a lot between them:
    // gemini-2.5-flash allows only 20 requests/day, which one validation run
    // exhausts. The lite tier is the generous one, and the "-latest" alias
    // keeps working when a specific version is retired (gemini-2.0-flash and
    // gemini-2.5-flash-lite both now 404 on this endpoint).
    // Override with LLM_MODEL if you have a paid project.
    model: "gemini-flash-lite-latest",
    label: "Gemini (free tier)",
    envKey: "GEMINI_API_KEY",
    // Gemini's flash models think by default, and that thinking is charged
    // against max_tokens. Left alone, gemini-2.5-flash spent 1918 tokens of a
    // 2000 budget reasoning and returned JSON truncated mid-string. "low" keeps
    // useful reasoning — this is a judgment call, not an extraction task —
    // while leaving room for the answer.
    extraBody: { reasoning_effort: "low" },
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    label: "Groq (free tier)",
    envKey: "GROQ_API_KEY",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.1",
    label: "Ollama (local)",
    envKey: "OLLAMA_API_KEY",
  },
};

/**
 * Resolve the provider from the environment.
 *
 * Explicit LLM_PROVIDER wins. Otherwise the first key present is used, so
 * dropping a single key into .env is enough to turn the judgment layer on.
 */
export function resolveProvider(): ProviderConfig {
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase();

  if (explicit === "anthropic" || (!explicit && process.env.ANTHROPIC_API_KEY)) {
    return {
      kind: "anthropic",
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
      apiKey: process.env.ANTHROPIC_API_KEY,
      label: `Anthropic ${process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"}`,
    };
  }

  const presetName =
    explicit && explicit in PRESETS
      ? explicit
      : Object.keys(PRESETS).find((name) => process.env[PRESETS[name].envKey]);

  if (presetName) {
    const p = PRESETS[presetName];
    const model = process.env.LLM_MODEL ?? p.model;
    return {
      kind: "openai-compat",
      model,
      // Ollama needs no key; send a placeholder so the header is well-formed.
      apiKey: process.env[p.envKey] ?? process.env.LLM_API_KEY ?? "ollama",
      baseUrl: process.env.LLM_BASE_URL ?? p.baseUrl,
      label: `${p.label} · ${model}`,
      extraBody: process.env.LLM_REASONING_EFFORT
        ? { ...p.extraBody, reasoning_effort: process.env.LLM_REASONING_EFFORT }
        : p.extraBody,
    };
  }

  // Fully manual: any OpenAI-compatible endpoint.
  if (process.env.LLM_BASE_URL && process.env.LLM_MODEL) {
    return {
      kind: "openai-compat",
      model: process.env.LLM_MODEL,
      apiKey: process.env.LLM_API_KEY ?? "none",
      baseUrl: process.env.LLM_BASE_URL,
      label: `${process.env.LLM_BASE_URL} · ${process.env.LLM_MODEL}`,
    };
  }

  return { kind: "none", model: "", label: "unavailable — deterministic fallback" };
}

export function providerAvailable(): boolean {
  return resolveProvider().kind !== "none";
}

export type CallResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export type CallOptions<T> = {
  schema: ZodType<T>;
  /** Schema name sent to providers that require one */
  schemaName: string;
  system: string;
  /** Precomputed facts. Serialized to JSON — the model never sees raw objects. */
  facts: unknown;
  temperature?: number;
  maxTokens?: number;
};

/*
 * There is deliberately no `seed` option.
 *
 * It was added to make the decision calls reproducible and removed the same
 * hour: Gemini's endpoint rejects the field outright with
 * `Unknown name "seed": Cannot find field`, so every timing and execution call
 * 400'd and fell back to the deterministic default — a silent downgrade of the
 * judgment layer in exchange for a parameter the default provider does not
 * implement. "Harmless if ignored" was the wrong assumption; unknown fields are
 * not always ignored.
 *
 * Decisions run at temperature 0, which is as close to repeatable as this
 * provider offers, and the docs say plainly that a marginal verdict is not
 * reproducible. The arithmetic is, and that is the part that matters.
 */

export async function structuredCall<T>(opts: CallOptions<T>): Promise<CallResult<T>> {
  const provider = resolveProvider();
  if (provider.kind === "none") {
    return { ok: false, reason: "no LLM provider configured" };
  }

  try {
    const raw =
      provider.kind === "anthropic"
        ? await callAnthropic(provider, opts)
        : await callOpenAiCompatible(provider, opts);

    if (raw == null) return { ok: false, reason: "provider returned no content" };

    // Validate here regardless of backend. A provider that ignored the schema
    // fails at this line rather than downstream.
    const parsed = opts.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        reason: `response failed schema validation: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
          .join("; ")}`,
      };
    }
    return { ok: true, value: parsed.data };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function callAnthropic<T>(provider: ProviderConfig, opts: CallOptions<T>): Promise<unknown> {
  const sampling =
    opts.temperature != null && supportsTemperature(provider.model)
      ? { temperature: opts.temperature }
      : {};

  const res = await getClient().messages.parse({
    model: provider.model,
    max_tokens: opts.maxTokens ?? 2000,
    system: opts.system,
    ...sampling,
    messages: [{ role: "user", content: JSON.stringify(opts.facts, null, 2) }],
    output_config: { format: zodOutputFormat(opts.schema as ZodType) },
  });

  return res.parsed_output ?? null;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (Gemini, Groq, OpenRouter, Ollama, …)
// ---------------------------------------------------------------------------

async function callOpenAiCompatible<T>(
  provider: ProviderConfig,
  opts: CallOptions<T>,
): Promise<unknown> {
  const jsonSchema = z.toJSONSchema(opts.schema as ZodType, { io: "output" });

  const body = (responseFormat: unknown) => ({
    model: provider.model,
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    ...(provider.extraBody ?? {}),
    max_tokens: opts.maxTokens ?? 2000,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: JSON.stringify(opts.facts, null, 2) },
    ],
    response_format: responseFormat,
  });

  const strict = {
    type: "json_schema",
    json_schema: { name: opts.schemaName, schema: jsonSchema, strict: true },
  };

  let text = await postWithRetry(provider, body(strict));

  // Not every OpenAI-compatible endpoint implements json_schema. Fall back to
  // plain JSON mode with the schema inlined in the prompt — we validate with
  // zod either way, so this costs strictness at the provider, not safety.
  if (text == null) {
    const relaxed = {
      ...body({ type: "json_object" }),
      messages: [
        {
          role: "system",
          content: `${opts.system}\n\nRespond with a single JSON object conforming exactly to this JSON Schema. No prose, no code fence:\n${JSON.stringify(jsonSchema)}`,
        },
        { role: "user", content: JSON.stringify(opts.facts, null, 2) },
      ],
    };
    text = await postWithRetry(provider, relaxed, { throwOnError: true });
  }

  if (text == null) return null;
  const parsed = parseLoose(text);
  if (parsed == null) {
    debug(`content did not parse as JSON (${text.length} chars): ${text.slice(0, 400)}`);
  }
  return parsed;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Free tiers are rate-limited by the minute (Gemini: ~15 rpm), and a review
 * makes several calls in quick succession, so a 429 is an expected condition
 * rather than an error. Back off and retry instead of degrading the decision.
 */
async function postWithRetry(
  provider: ProviderConfig,
  body: unknown,
  opts: { throwOnError?: boolean } = {},
): Promise<string | null> {
  const maxAttempts = Number(process.env.LLM_MAX_RETRIES ?? 4);

  for (let attempt = 1; ; attempt++) {
    try {
      return await post(provider, body, opts);
    } catch (err) {
      const retryAfter = err instanceof RateLimited ? err.retryAfterMs : null;
      if (retryAfter == null || attempt >= maxAttempts) {
        if (err instanceof RateLimited) {
          throw new Error(
            `${provider.label} rate limit reached after ${attempt} attempts — ` +
              "wait a minute, or set LLM_MAX_RETRIES higher",
          );
        }
        throw err;
      }
      debug(`429 — backing off ${retryAfter}ms (attempt ${attempt}/${maxAttempts})`);
      await sleep(retryAfter);
    }
  }
}

class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super("rate limited");
  }
}

async function post(
  provider: ProviderConfig,
  body: unknown,
  opts: { throwOnError?: boolean } = {},
): Promise<string | null> {
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const header = res.headers.get("retry-after");
    const fromHeader = header ? Number(header) * 1000 : NaN;
    // Free-tier quotas reset on the minute, so a short retry usually fails
    // again; default to a full window rather than hammering.
    throw new RateLimited(Number.isFinite(fromHeader) ? fromHeader : 20_000);
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (opts.throwOnError) {
      throw new Error(`${provider.label} -> HTTP ${res.status}: ${detail}`);
    }
    debug(`HTTP ${res.status} on strict attempt: ${detail}`);
    return null; // caller retries with the relaxed response format
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: Record<string, number>;
  };

  const choice = json.choices?.[0];
  const content = choice?.message?.content ?? null;

  if (choice?.finish_reason === "length") {
    // The single most confusing failure: a 200 with syntactically broken JSON
    // because the budget ran out mid-answer. Name it rather than reporting a
    // generic parse error.
    debug(`truncated at max_tokens — usage=${JSON.stringify(json.usage ?? {})}`);
    throw new Error(
      "response truncated at max_tokens (the model spent the budget before finishing) — " +
        "raise maxTokens or lower reasoning effort",
    );
  }

  if (!content) {
    // Empty content with a 200 is the failure mode that is hardest to diagnose
    // blind: a reasoning model can spend the whole token budget thinking and
    // return nothing. Surface finish_reason and usage rather than a bare null.
    debug(
      `empty content — finish_reason=${choice?.finish_reason ?? "?"} usage=${JSON.stringify(json.usage ?? {})}`,
    );
  }
  return content;
}

/** Set LLM_DEBUG=1 to trace provider responses when a decision falls back. */
function debug(msg: string): void {
  if (process.env.LLM_DEBUG) console.warn(`[llm:debug] ${msg}`);
}

/**
 * Some models wrap JSON in a markdown fence or add a sentence before it.
 * Recover the object rather than failing the whole decision over formatting.
 */
export function parseLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* fall through */
    }
  }

  return null;
}
