/**
 * Where watches live.
 *
 * A watch has to outlive the request that created it — that is the whole point
 * — so this is the one piece of durable state the app owns. There is no
 * database, and pretending otherwise would produce a demo that silently forgets
 * every subscription on the next cold start.
 *
 * So the backend is chosen from what the environment actually offers, and
 * `describeStore()` reports which one is in use so the UI and the health route
 * can say it out loud rather than implying a durability that is not there:
 *
 *   redis   Upstash REST, if KV_REST_API_URL / KV_REST_API_TOKEN are set
 *           (the names Vercel's Upstash integration provisions). Durable.
 *   file    data/watches.json, when not running on Vercel. Survives restarts
 *           locally; that is what development needs.
 *   memory  Last resort. Works, and is gone on the next cold start. The health
 *           route reports it as a warning, not as normal.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { fetchJson } from "../lib/http";
import type { Allocation, Preference } from "../types";
import type { WatchVerdict } from "../lib/watch";

export type WatchRecord = {
  /** Also the one-time token the user carries into Telegram to bind the chat. */
  id: string;
  /** Null until they press Start in Telegram. */
  chatId: number | null;
  createdAt: string;
  boundAt: string | null;
  label: string | null;

  allocation: Allocation;
  quantities: Record<string, number>;
  preference: Preference;

  paused: boolean;
  /** Hours before the same unchanged verdict is repeated. */
  repeatAfterHours: number;

  lastCheckedAt: string | null;
  /** When the model last actually judged a breach — throttles LLM spend. */
  lastJudgedAt?: string | null;
  lastNotifiedAt: string | null;
  /** ISO timestamps of recent messages, newest last — the attention budget. */
  notifiedAt?: string[];
  lastSignature: string | null;
  lastVerdict: WatchVerdict | null;
};

export type StoreKind = "redis" | "file" | "memory";

export interface WatchStore {
  kind: StoreKind;
  get(id: string): Promise<WatchRecord | null>;
  put(record: WatchRecord): Promise<void>;
  remove(id: string): Promise<void>;
  all(): Promise<WatchRecord[]>;
  /** Which watch a Telegram chat is bound to, so /stop and /check work from the chat. */
  byChat(chatId: number): Promise<WatchRecord | null>;
}

export function newWatchId(): string {
  // Telegram's deep-link payload allows [A-Za-z0-9_-] and at most 64 chars.
  return randomBytes(18).toString("base64url");
}

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

const mem = new Map<string, WatchRecord>();

const memoryStore: WatchStore = {
  kind: "memory",
  async get(id) {
    return mem.get(id) ?? null;
  },
  async put(record) {
    mem.set(record.id, record);
  },
  async remove(id) {
    mem.delete(id);
  },
  async all() {
    return [...mem.values()];
  },
  async byChat(chatId) {
    return [...mem.values()].find((w) => w.chatId === chatId) ?? null;
  },
};

// ---------------------------------------------------------------------------
// file
// ---------------------------------------------------------------------------

const FILE = path.resolve(process.cwd(), "data", "watches.json");

async function readAll(): Promise<Record<string, WatchRecord>> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Record<string, WatchRecord>;
  } catch {
    return {};
  }
}

async function writeAll(all: Record<string, WatchRecord>): Promise<void> {
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(all, null, 2), "utf8");
}

const fileStore: WatchStore = {
  kind: "file",
  async get(id) {
    return (await readAll())[id] ?? null;
  },
  async put(record) {
    const all = await readAll();
    all[record.id] = record;
    await writeAll(all);
  },
  async remove(id) {
    const all = await readAll();
    delete all[id];
    await writeAll(all);
  },
  async all() {
    return Object.values(await readAll());
  },
  async byChat(chatId) {
    return Object.values(await readAll()).find((w) => w.chatId === chatId) ?? null;
  },
};

// ---------------------------------------------------------------------------
// redis (Upstash REST)
// ---------------------------------------------------------------------------

function redisConfig(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

const KEY = (id: string) => `watch:${id}`;
const INDEX = "watch:index";
const CHAT = (chatId: number) => `watch:chat:${chatId}`;

async function redis<T>(cfg: { url: string; token: string }, command: unknown[]): Promise<T> {
  const res = await fetchJson<{ result: T }>(cfg.url, {
    method: "POST",
    body: JSON.stringify(command),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
    timeoutMs: 8_000,
  });
  return res.result;
}

function redisStore(cfg: { url: string; token: string }): WatchStore {
  const store: WatchStore = {
    kind: "redis",
    async get(id) {
      const raw = await redis<string | null>(cfg, ["GET", KEY(id)]);
      return raw ? (JSON.parse(raw) as WatchRecord) : null;
    },
    async put(record) {
      await redis(cfg, ["SET", KEY(record.id), JSON.stringify(record)]);
      await redis(cfg, ["SADD", INDEX, record.id]);
      // A chat maps to at most one watch; binding a new one replaces the link.
      if (record.chatId != null) await redis(cfg, ["SET", CHAT(record.chatId), record.id]);
    },
    async remove(id) {
      const existing = await store.get(id);
      await redis(cfg, ["DEL", KEY(id)]);
      await redis(cfg, ["SREM", INDEX, id]);
      if (existing?.chatId != null) await redis(cfg, ["DEL", CHAT(existing.chatId)]);
    },
    async all() {
      const ids = (await redis<string[]>(cfg, ["SMEMBERS", INDEX])) ?? [];
      if (ids.length === 0) return [];
      const raw = await redis<(string | null)[]>(cfg, ["MGET", ...ids.map(KEY)]);
      const out: WatchRecord[] = [];
      raw.forEach((r, i) => {
        if (r) out.push(JSON.parse(r) as WatchRecord);
        // An id in the index with no record is a torn write from a previous
        // run. Drop it so the index does not grow stale forever.
        else void redis(cfg, ["SREM", INDEX, ids[i]]);
      });
      return out;
    },
    async byChat(chatId) {
      const id = await redis<string | null>(cfg, ["GET", CHAT(chatId)]);
      return id ? store.get(id) : null;
    },
  };
  return store;
}

// ---------------------------------------------------------------------------

let cached: WatchStore | null = null;

export function watchStore(): WatchStore {
  if (cached) return cached;
  const cfg = redisConfig();
  if (cfg) cached = redisStore(cfg);
  else if (!process.env.VERCEL) cached = fileStore;
  else cached = memoryStore;
  return cached;
}

/** For the health route and the UI, so the durability story is never implied. */
export function describeStore(): { kind: StoreKind; durable: boolean; note: string } {
  const kind = watchStore().kind;
  if (kind === "redis") return { kind, durable: true, note: "Upstash Redis" };
  if (kind === "file") {
    return { kind, durable: true, note: "data/watches.json — local development only" };
  }
  return {
    kind,
    durable: false,
    note: "in memory — watches are lost on the next cold start. Set KV_REST_API_URL and KV_REST_API_TOKEN to make them durable.",
  };
}

/** Tests need a clean slate without touching disk. */
export function __resetStoreForTests(store?: WatchStore): void {
  cached = store ?? null;
  mem.clear();
}
