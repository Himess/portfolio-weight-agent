/**
 * Encrypted, signed values that survive a serverless deployment.
 *
 * The OAuth flow kept its PKCE verifier and the resulting token in module-level
 * Maps. That works on one long-lived process and breaks the moment the app is
 * deployed: each request may land on a different instance, so the callback
 * would not find the verifier the start handler stored, and a token written by
 * one invocation would be gone by the next. The flow would appear to succeed
 * and then immediately behave as if it had never happened.
 *
 * So the state travels with the browser instead — in httpOnly cookies, sealed
 * with AES-256-GCM. httpOnly keeps it out of reach of page scripts; GCM means a
 * tampered cookie fails to open rather than decoding into something attacker-
 * chosen; and the payload carries its own expiry so a stale cookie cannot be
 * replayed indefinitely.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

/**
 * Key material. In production this must be set — a random per-boot key would
 * invalidate every cookie on each cold start, which on serverless is constantly.
 * Locally we fall back to a fixed development key so the flow is testable
 * without configuration, and say so loudly if that happens in production.
 */
function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "AUTH_SECRET is not set. Set it to a random 32+ character string, or the Binance connection cannot be kept across requests.",
      );
    }
    return createHash("sha256").update("development-only-insecure-key").digest();
  }
  // Any length of secret, one fixed-size key.
  return createHash("sha256").update(secret).digest();
}

type Envelope<T> = { v: T; exp: number };

export function seal<T>(value: T, ttlMs: number): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key(), iv);
  const envelope: Envelope<T> = { v: value, exp: Date.now() + ttlMs };
  const body = Buffer.concat([
    cipher.update(JSON.stringify(envelope), "utf8"),
    cipher.final(),
  ]);
  // iv | tag | ciphertext, one opaque base64url string.
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function unseal<T>(sealed: string | undefined): T | null {
  if (!sealed) return null;
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length < IV_BYTES + 16 + 1) return null;

    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + 16);
    const body = raw.subarray(IV_BYTES + 16);

    const decipher = createDecipheriv(ALGO, key(), iv);
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");

    const envelope = JSON.parse(text) as Envelope<T>;
    // Expiry is inside the sealed payload, so it cannot be edited from outside.
    if (!envelope || typeof envelope.exp !== "number" || Date.now() > envelope.exp) return null;
    return envelope.v;
  } catch {
    // A wrong key, a tampered payload or a truncated cookie all land here.
    return null;
  }
}

export const COOKIE = {
  pkce: "pwa_pkce",
  token: "pwa_mcp",
} as const;

/** Cookie attributes. Secure is conditional so the flow still works on http://localhost. */
export function cookieOptions(maxAgeSeconds: number, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
