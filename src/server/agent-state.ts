/**
 * What the agent remembers between calls.
 *
 * The web app keeps its allocation in the browser, which is right for a page
 * someone opens twice. An MCP server has no browser: Claude Code calls
 * `set_allocation` in one turn and `propose_rebalance` in the next, possibly
 * minutes apart, and the allocation has to still be there.
 *
 * Two things live here beyond the allocation, and both exist to answer a
 * question the product kept failing to answer well:
 *
 *   lastProposal  the *fact sheet* the last verdict was made from, not a
 *                 summary of it. "Why didn't you sell AVAX?" has to be
 *                 answerable with the numbers that actually drove the call,
 *                 and a second guess at the question is not an answer.
 *   decisions     an append-only log. One captured HOLD is an anecdote; a
 *                 sequence of them with their reasons is the claim this
 *                 product makes, and it cannot be made from a screenshot.
 *
 * Backends follow the same rule as the watch store: use what the environment
 * offers and say which, rather than implying a durability that is not there.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { fetchJson } from "../lib/http";
import type {
  Allocation,
  CandidateTrade,
  OrderedTrade,
  Preference,
  PrimaryFactor,
  RebalanceContext,
  TimingAction,
  TimingDecision,
} from "../types";

export type Decision = {
  at: string;
  verdict: TimingAction;
  primaryFactor: PrimaryFactor;
  totalDriftPp: number;
  navUsd: number;
  /** Symbols outside their band when the call was made. */
  outsideBand: string[];
  /** One line, from the model's own reasoning — trimmed, never rewritten. */
  reason: string;
  proposedLegs: number;
  fellBack: boolean;
  source: "mcp" | "web" | "watch";
};

export type StoredProposal = {
  at: string;
  context: RebalanceContext;
  timing: TimingDecision;
  orderedTrades: OrderedTrade[];
  /**
   * What it chose not to do, sized and priced. On a HOLD this is the whole
   * point: a threshold rule would have sent these, and the agent declined.
   */
  declined: CandidateTrade[];
  narrative: string;
};

export type AgentState = {
  allocation: Allocation | null;
  preference: Preference;
  lastProposal: StoredProposal | null;
  decisions: Decision[];
};

/** Enough history to show a pattern; old entries are not worth unbounded storage. */
const MAX_DECISIONS = 200;

const EMPTY: AgentState = {
  allocation: null,
  preference: "balanced",
  lastProposal: null,
  decisions: [],
};

// ---------------------------------------------------------------------------

type Backend = { kind: "redis" | "file" | "memory"; read(): Promise<AgentState>; write(s: AgentState): Promise<void> };

const FILE = path.resolve(process.cwd(), "data", "agent-state.json");
let memory: AgentState = EMPTY;

function redisConfig(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

async function redis<T>(cfg: { url: string; token: string }, command: unknown[]): Promise<T> {
  const res = await fetchJson<{ result: T }>(cfg.url, {
    method: "POST",
    body: JSON.stringify(command),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
    timeoutMs: 8_000,
  });
  return res.result;
}

function pick(): Backend {
  const cfg = redisConfig();
  if (cfg) {
    return {
      kind: "redis",
      async read() {
        const raw = await redis<string | null>(cfg, ["GET", "agent:state"]);
        return raw ? ({ ...EMPTY, ...(JSON.parse(raw) as AgentState) }) : EMPTY;
      },
      async write(state) {
        await redis(cfg, ["SET", "agent:state", JSON.stringify(state)]);
      },
    };
  }

  if (!process.env.VERCEL) {
    return {
      kind: "file",
      async read() {
        try {
          return { ...EMPTY, ...(JSON.parse(await readFile(FILE, "utf8")) as AgentState) };
        } catch {
          return EMPTY;
        }
      },
      async write(state) {
        await mkdir(path.dirname(FILE), { recursive: true });
        await writeFile(FILE, JSON.stringify(state, null, 2), "utf8");
      },
    };
  }

  return {
    kind: "memory",
    async read() {
      return memory;
    },
    async write(state) {
      memory = state;
    },
  };
}

let backend: Backend | null = null;
function store(): Backend {
  if (!backend) backend = pick();
  return backend;
}

// ---------------------------------------------------------------------------

export async function readState(): Promise<AgentState> {
  return store().read();
}

export async function setAllocation(allocation: Allocation, preference?: Preference): Promise<void> {
  const state = await readState();
  await store().write({ ...state, allocation, preference: preference ?? state.preference });
}

export async function setPreference(preference: Preference): Promise<void> {
  const state = await readState();
  await store().write({ ...state, preference });
}

/** Record a verdict and the fact sheet behind it, in one write. */
export async function recordProposal(
  proposal: StoredProposal,
  source: Decision["source"],
): Promise<Decision> {
  const state = await readState();

  const decision: Decision = {
    at: proposal.at,
    verdict: proposal.timing.action,
    primaryFactor: proposal.timing.primaryFactor,
    totalDriftPp: Number(proposal.context.portfolio.totalDriftPp.toFixed(3)),
    navUsd: Number(proposal.context.portfolio.navUsd.toFixed(2)),
    outsideBand: proposal.context.portfolio.rows
      .filter((r) => r.outsideBand && r.symbol !== proposal.context.cashSymbol)
      .map((r) => r.symbol),
    // The model's own sentence, cut to one line. Rewriting it here would make
    // the log a summary of a summary.
    reason: proposal.timing.reasoning.split(/(?<=[.!?])\s/)[0]?.trim() ?? "",
    proposedLegs: proposal.orderedTrades.length,
    fellBack: proposal.timing.fellBack === true,
    source,
  };

  await store().write({
    ...state,
    lastProposal: proposal,
    decisions: [...state.decisions, decision].slice(-MAX_DECISIONS),
  });
  return decision;
}

export async function listDecisions(limit = 20): Promise<Decision[]> {
  const state = await readState();
  return state.decisions.slice(-Math.max(1, Math.min(limit, MAX_DECISIONS))).reverse();
}

/** For the health route and the MCP server banner — never imply durability. */
export function describeState(): { kind: Backend["kind"]; durable: boolean } {
  const kind = store().kind;
  return { kind, durable: kind !== "memory" };
}

/** Tests need a clean slate without touching disk. */
export function __resetStateForTests(): void {
  backend = { kind: "memory", async read() { return memory; }, async write(s) { memory = s; } };
  memory = EMPTY;
}
