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
};

/** Known OpenAI-compatible endpoints, so the common cases need one env var. */
const PRESETS: Record<string, { baseUrl: string; model: string; label: string; envKey: string }> = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    label: "Gemini (free tier)",
    envKey: "GEMINI_API_KEY",
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

  let text = await post(provider, body(strict));

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
    text = await post(provider, relaxed, { throwOnError: true });
  }

  return text == null ? null : parseLoose(text);
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

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (opts.throwOnError) {
      throw new Error(`${provider.label} -> HTTP ${res.status}: ${detail}`);
    }
    return null; // caller retries with the relaxed response format
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content ?? null;
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
