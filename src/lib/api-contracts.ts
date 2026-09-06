/**
 * Request contracts for the HTTP API.
 *
 * The routes previously read fields straight off a parsed body. `allocation`
 * went through validateAllocation, which checks weights — but nothing checked
 * that `targets` was even an array of the right shape, so a malformed payload
 * failed somewhere deep in the core with a stack trace instead of at the door
 * with a reason.
 *
 * Parsing at the boundary means every handler below it can trust its input, and
 * a bad request gets an answer that says which field was wrong.
 *
 * These describe the *wire*, not the domain. The domain types in src/types.ts
 * stay the source of truth for everything past this line; the schemas are
 * checked against them at compile time below.
 */

import { z } from "zod";

import type { Allocation, Preference } from "../types";

const Symbol_ = z
  .string()
  .trim()
  .min(1, "symbol is required")
  .max(20, "symbol is implausibly long")
  .regex(/^[A-Za-z0-9]+$/, "symbol must be alphanumeric")
  .transform((s) => s.toUpperCase());

const Weight = z.number().finite().min(0).max(1);

const TargetLeafSchema = z.object({
  kind: z.literal("asset"),
  symbol: Symbol_,
  weight: Weight,
});

const BasketMemberSchema = z.object({
  symbol: Symbol_,
  weight: Weight,
  why: z.string().max(400).optional(),
});

const TargetBasketSchema = z.object({
  kind: z.literal("basket"),
  label: z.string().trim().min(1).max(80),
  weight: Weight,
  members: z.array(BasketMemberSchema).min(1).max(24),
  resolvedAt: z.string().min(1),
  rationale: z.string().max(2000),
});

export const TargetSchema = z.discriminatedUnion("kind", [TargetLeafSchema, TargetBasketSchema]);

export const AllocationSchema = z.object({
  // An allocation with hundreds of legs is not a portfolio, it is a denial of
  // service against the market-data calls each leg triggers.
  targets: z.array(TargetSchema).min(1).max(40),
  cashSymbol: Symbol_,
});

export const PreferenceSchema = z.enum(["patient", "balanced", "tight"]);

export const ReviewRequestSchema = z
  .object({
    allocation: AllocationSchema,
    quantities: z.record(Symbol_, z.number().finite().nonnegative()).optional(),
    preference: PreferenceSchema.default("balanced"),
    daysSinceLastRebalance: z.number().finite().nonnegative().nullable().default(null),
    source: z.enum(["public", "replay"]).default("public"),
    dataset: z.string().max(200).optional(),
    bar: z.number().int().nonnegative().optional(),
    seedBar: z.number().int().nonnegative().optional(),
    seedNavUsd: z.number().finite().positive().max(1e12).optional(),
  })
  .refine((v) => v.source !== "public" || (v.quantities && Object.keys(v.quantities).length > 0), {
    message: "Live mode needs holdings — enter quantities, or use the replay source.",
    path: ["quantities"],
  });

export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const BasketRequestSchema = z.object({
  phrase: z.string().trim().min(1, "A category phrase is required.").max(120),
});

export const McpTokenRequestSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20, "That does not look like an access token.")
    .max(4096, "That is too long to be an access token."),
});

/**
 * Query params arrive as strings. These clamp rather than reject: a limit of
 * 99999 is someone asking for "everything", not an attack, and answering with
 * the maximum is more useful than a 400. A body is different — there we reject,
 * because a malformed allocation means the caller has a bug worth surfacing.
 */
export const TokensQuerySchema = z.object({
  limit: z.coerce
    .number()
    .catch(250)
    .transform((n) => Math.min(500, Math.max(1, Math.floor(n) || 250))),
});

export const SparksQuerySchema = z.object({
  symbols: z
    .string()
    .default("")
    .transform((raw) =>
      [...new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))]
        .filter((s) => /^[A-Z0-9]{1,20}$/.test(s))
        .slice(0, 14),
    ),
});

// ---------------------------------------------------------------------------
// The wire and the domain must not drift apart
// ---------------------------------------------------------------------------

/**
 * These assignments do nothing at runtime; they fail the build if a schema
 * stops producing the domain type it claims to. Without them the two
 * definitions could diverge silently and the mismatch would only appear as a
 * confusing runtime error.
 */
const _allocationMatchesDomain: Allocation = {} as z.infer<typeof AllocationSchema>;
const _preferenceMatchesDomain: Preference = "balanced" as z.infer<typeof PreferenceSchema>;
void _allocationMatchesDomain;
void _preferenceMatchesDomain;

/** First failure, rendered for a human: "allocation.targets.0.weight — ...". */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request.";
  const path = issue.path.join(".");
  return path ? `${path} — ${issue.message}` : issue.message;
}
