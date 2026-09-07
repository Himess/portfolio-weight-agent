/**
 * The agent, as an MCP server.
 *
 * This is a shell over `src/core/` and `src/llm/`, not a second implementation.
 * Every figure it returns is produced by the same pure functions the web app
 * uses, and the same rule applies with more force here than anywhere else:
 * **the model selects and explains, it never computes.** The calling model is
 * Claude Code, which is not constrained by this project's prompts, so anything
 * this server hands back has to be true on its own.
 *
 * Where the pieces live, because it is the part people get wrong:
 *
 *   holdings      arrive as tool *inputs*. Claude reads them from Binance's own
 *                 MCP server and passes them in. This server cannot call that
 *                 one — Claude Code is the orchestrator and holds both
 *                 connections.
 *   market data   fetched here, directly, from Binance's public endpoints,
 *                 which need no auth. Deliberately not relayed through Claude:
 *                 a model asked to carry a price will round it, and every
 *                 downstream figure depends on it being exact.
 *   orders        never placed. A materialised plan is returned; Claude sends
 *                 it through the Binance MCP server; Binance shows its own
 *                 confirmation dialog to the person. There is no tool here that
 *                 trades, and there is no withdrawal scope in Binance's MCP
 *                 server at all.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { runReview } from "../agent";
import { flattenTargets, normalizeMemberWeights, validateAllocation } from "../core/allocation";
import { bandsFor } from "../core/bands";
import { MissingPriceError, buildHoldings, computeDrift, unpricedSymbols } from "../core/drift";
import { volScales } from "../core/bands";
import { resolveBasket } from "../llm/basket";
import { publicAdapter } from "../server/session";
import {
  listDecisions,
  readState,
  recordProposal,
  setAllocation,
  type StoredProposal,
} from "../server/agent-state";
import type { Allocation, Kline, Preference, Target } from "../types";

const PREFERENCES = ["patient", "balanced", "tight", "continuous"] as const;

/** Two weeks of hourly closes, the same window the app scales bands from. */
const VOL_LOOKBACK_BARS = 336;

const CASH = "USDT";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Every tool answers as JSON. Prose in a tool result is a thing to parse wrong. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }],
    isError: true,
  };
}

const HoldingsShape = z
  .array(z.object({ symbol: z.string(), qty: z.number().finite().nonnegative() }))
  .describe("Balances read from the Binance MCP server: [{ symbol, qty }].");

function quantitiesOf(holdings: { symbol: string; qty: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of holdings) {
    const symbol = h.symbol.trim().toUpperCase();
    if (h.qty > 0) out[symbol] = (out[symbol] ?? 0) + h.qty;
  }
  return out;
}

async function requireAllocation(): Promise<
  { ok: true; allocation: Allocation; preference: Preference } | { ok: false; message: string }
> {
  const state = await readState();
  if (!state.allocation) {
    return { ok: false, message: "No allocation set yet. Call set_allocation first." };
  }
  return { ok: true, allocation: state.allocation, preference: state.preference };
}

/** Recent hourly closes for volatility scaling — the bands depend on them. */
async function history(symbols: string[]): Promise<Record<string, Kline[]>> {
  const market = publicAdapter();
  const out: Record<string, Kline[]> = {};
  await Promise.all(
    symbols
      .filter((s) => s !== CASH)
      .map(async (symbol) => {
        try {
          out[symbol] = await market.getKlines(symbol, "1h", VOL_LOOKBACK_BARS);
        } catch {
          /* no history means no scaling for that symbol, which is the fixed band */
        }
      }),
  );
  return out;
}

// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "portfolio-weight-agent", version: "1.0.0" },
    {
      instructions:
        "A portfolio rebalancing agent for Binance spot. It decides *whether now is a good " +
        "moment* to correct a known drift, and can decline. Read balances from the Binance MCP " +
        "server and pass them in as `holdings`; this server fetches its own market data. It " +
        "never places an order: propose_rebalance returns a materialised plan for you to send " +
        "through the Binance MCP server, where Binance asks the user to confirm each one.",
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "set_allocation",
    {
      title: "Set the target allocation",
      description:
        "Declare target weights, once. Each target is either { symbol, weight } or " +
        "{ category, weight } — a category like 'AI tokens' is resolved to real symbols and " +
        "returned with its rationale and exclusions for the user to approve. Weights are " +
        "fractions and must sum to 1.0. Unknown or untradable symbols are rejected, never " +
        "silently dropped.",
      inputSchema: {
        targets: z.array(
          z.object({
            symbol: z.string().optional().describe("A Binance base asset, e.g. BTC"),
            category: z.string().optional().describe("A theme to resolve, e.g. 'AI tokens'"),
            weight: z.number().finite().positive().max(1),
          }),
        ),
        tracking: z
          .enum(PREFERENCES)
          .optional()
          .describe(
            "How much drift to tolerate. Sets the band: patient ±2.5pp, balanced ±1.5pp, " +
              "tight ±0.75pp, continuous ±0.4pp on a 30% position, each scaled by the asset's " +
              "own realised volatility.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ targets, tracking }) => {
      const market = publicAdapter();
      let tradable: string[];
      try {
        tradable = await market.getTradableSymbols();
      } catch (err) {
        return fail(`Could not reach Binance market data: ${err instanceof Error ? err.message : err}`);
      }
      const universe = new Set(tradable);

      const built: Target[] = [];
      const resolutions: unknown[] = [];

      for (const t of targets) {
        if (t.category) {
          const volumes = await market.getQuoteVolumes();
          const res = await resolveBasket({ phrase: t.category, tradable, volumes });
          const members = normalizeMemberWeights(res.members);
          if (!members) {
            return fail(`Could not resolve "${t.category}" into a usable basket.`, {
              rationale: res.rationale,
            });
          }
          built.push({
            kind: "basket",
            label: t.category,
            weight: t.weight,
            members,
            resolvedAt: new Date().toISOString(),
            rationale: res.rationale,
          });
          // Surfaced so the user can see what a phrase became before approving.
          resolutions.push({
            category: t.category,
            members: members.map((m) => ({ symbol: m.symbol, weight: m.weight, why: m.why })),
            excluded: res.excluded,
            rationale: res.rationale,
            confidence: res.confidence,
            pinned: "Members are frozen at this moment and never re-resolve on their own.",
          });
          continue;
        }

        const symbol = (t.symbol ?? "").trim().toUpperCase();
        if (!symbol) return fail("Each target needs either a symbol or a category.");
        if (symbol !== CASH && !universe.has(symbol)) {
          return fail(`${symbol} does not trade against ${CASH} on Binance.`);
        }
        built.push({ kind: "asset", symbol, weight: t.weight });
      }

      const allocation: Allocation = { targets: built, cashSymbol: CASH };
      const check = validateAllocation(allocation);
      if (!check.ok) return fail(check.errors.join(" "));

      await setAllocation(allocation, tracking);
      const state = await readState();

      return json({
        ok: true,
        allocation: {
          cashSymbol: CASH,
          targets: built.map((t) =>
            t.kind === "asset"
              ? { symbol: t.symbol, weightPct: t.weight * 100 }
              : {
                  basket: t.label,
                  weightPct: t.weight * 100,
                  members: t.members.map((m) => ({ symbol: m.symbol, sharePct: m.weight * 100 })),
                },
          ),
        },
        tracking: state.preference,
        bands: bandsFor(state.preference),
        resolvedCategories: resolutions,
        next: "Read balances from the Binance MCP server, then call review_portfolio or propose_rebalance with them.",
      });
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "review_portfolio",
    {
      title: "Where the portfolio stands",
      description:
        "NAV, per-position target/current/drift/band, and which positions are outside their " +
        "band. Pure arithmetic on live Binance prices — no model is consulted and no judgment " +
        "is offered. Use this when you want the numbers; use propose_rebalance when you want a " +
        "decision.",
      inputSchema: { holdings: HoldingsShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ holdings }) => {
      const found = await requireAllocation();
      if (!found.ok) return fail(found.message);

      const quantities = quantitiesOf(holdings);
      if (Object.keys(quantities).length === 0) return fail("No holdings with a positive quantity.");

      const symbols = [
        ...new Set([...Object.keys(flattenTargets(found.allocation)), ...Object.keys(quantities)]),
      ];

      const market = publicAdapter();
      let prices: Record<string, number>;
      try {
        prices = await market.getPrices(symbols);
      } catch (err) {
        return fail(`Could not reach Binance market data: ${err instanceof Error ? err.message : err}`);
      }

      const unpriced = unpricedSymbols(symbols, prices, CASH);
      if (unpriced.length > 0) {
        // A missing price is an error, never a zero. Priced at zero, a position
        // reads as 0% weight and its whole target weight reads as drift.
        return fail(new MissingPriceError(unpriced).message, { unpriced });
      }

      const state = computeDrift(buildHoldings(quantities, prices, CASH), found.allocation, {
        bands: bandsFor(found.preference),
        volScale: volScales(await history(symbols)),
      });

      return json({
        asOf: state.asOf,
        navUsd: Number(state.navUsd.toFixed(2)),
        totalDriftPp: Number(state.totalDriftPp.toFixed(2)),
        tracking: found.preference,
        positions: state.rows.map((r) => ({
          symbol: r.symbol,
          targetPct: Number((r.targetWeight * 100).toFixed(2)),
          currentPct: Number((r.currentWeight * 100).toFixed(2)),
          driftPp: Number(r.driftPp.toFixed(2)),
          bandPp: Number(r.bandPp.toFixed(2)),
          outsideBand: r.outsideBand,
          toTargetUsd: Number(r.deltaUsd.toFixed(2)),
        })),
        outsideBand: state.rows.filter((r) => r.outsideBand && r.symbol !== CASH).map((r) => r.symbol),
        note:
          "Bands scale with each asset's realised volatility, so a calm asset has a tighter " +
          "band than a jumpy one at the same target weight.",
      });
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "propose_rebalance",
    {
      title: "Decide whether to act, and what to send",
      description:
        "Runs the full loop: drift, candidate trades with real order-book slippage, cost/benefit, " +
        "then the timing and execution decisions. Returns REBALANCE, PARTIAL or HOLD with the " +
        "reasoning and the fact sheet it was decided from. When acting, returns ordered legs with " +
        "exact quantities. When holding, returns the trade it declined to make — sized and priced " +
        "— because that is the claim: a threshold rule would have sent it. Places nothing.",
      inputSchema: {
        holdings: HoldingsShape,
        daysSinceLastRebalance: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Staleness matters to the timing call. Omit if unknown."),
        askedLast24h: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("How many proposals the user has already been shown today."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ holdings, daysSinceLastRebalance, askedLast24h }) => {
      const found = await requireAllocation();
      if (!found.ok) return fail(found.message);

      const quantities = quantitiesOf(holdings);
      if (Object.keys(quantities).length === 0) return fail("No holdings with a positive quantity.");

      let proposal;
      try {
        proposal = await runReview({
          market: publicAdapter(),
          allocation: found.allocation,
          quantities,
          preference: found.preference,
          daysSinceLastRebalance: daysSinceLastRebalance ?? null,
          askedLast24h,
        });
      } catch (err) {
        if (err instanceof MissingPriceError) return fail(err.message, { unpriced: err.symbols });
        return fail(err instanceof Error ? err.message : String(err));
      }

      const { context, timing } = proposal;
      const acting = timing.action !== "HOLD";

      // Computed by the agent itself: on a PARTIAL the declined legs are gone
      // from context.candidates, so they cannot be derived here.
      const declined = proposal.declined;

      const stored: StoredProposal = {
        at: context.asOf,
        context,
        timing,
        orderedTrades: proposal.orderedTrades,
        declined,
        narrative: proposal.narrative,
      };
      await recordProposal(stored, "mcp");

      return json({
        verdict: timing.action,
        primaryFactor: timing.primaryFactor,
        reasoning: timing.reasoning,
        narrative: proposal.narrative,
        usedDeterministicFallback: timing.fellBack === true,

        // The fact sheet, so the verdict can be checked rather than trusted.
        facts: {
          asOf: context.asOf,
          navUsd: Number(context.portfolio.navUsd.toFixed(2)),
          totalDriftPp: Number(context.portfolio.totalDriftPp.toFixed(2)),
          tracking: found.preference,
          outsideBand: context.portfolio.rows
            .filter((r) => r.outsideBand && r.symbol !== CASH)
            .map((r) => ({
              symbol: r.symbol,
              driftPp: Number(r.driftPp.toFixed(2)),
              bandPp: Number(r.bandPp.toFixed(2)),
            })),
          signals: context.signals.map((s) => ({
            symbol: s.symbol,
            priceChange4hPct: Number(s.priceChange4hPct.toFixed(2)),
            priceChange24hPct: Number(s.priceChange24hPct.toFixed(2)),
            volRatio: Number(s.volRatio.toFixed(2)),
            meaning: "volRatio is 4h volatility over 24h volatility — disorder, not direction.",
          })),
          costBenefit: {
            estimatedCostUsd: Number(context.costBenefit.estimatedCostUsd.toFixed(2)),
            costBps: Number(context.costBenefit.costBps.toFixed(2)),
            driftReductionPp: Number(context.costBenefit.driftReductionPp.toFixed(2)),
            costPerPpUsd: Number(context.costBenefit.costPerPpUsd.toFixed(2)),
          },
        },

        plan: proposal.orderedTrades.map((t, i) => ({
          step: i + 1,
          side: t.side,
          symbol: t.symbol,
          pair: t.pair,
          qty: t.qty,
          method: t.method,
          limitPriceOffsetBps: t.limitPriceOffsetBps,
          estPriceUsd: Number(t.estExecPrice.toFixed(6)),
          estNotionalUsd: Number(t.estNotionalUsd.toFixed(2)),
          estFeeUsd: Number(t.estFeeUsd.toFixed(2)),
          estSlippageUsd: Number(t.estSlippageUsd.toFixed(2)),
        })),

        declined: declined.map((c) => ({
          side: c.side,
          symbol: c.symbol,
          pair: c.pair,
          qty: c.qty,
          estNotionalUsd: Number(c.estNotionalUsd.toFixed(2)),
          estCostUsd: Number((c.estFeeUsd + c.estSlippageUsd).toFixed(2)),
          note: acting
            ? "Left out of this plan."
            : "A threshold rule would have sent this. The agent decided to wait.",
        })),

        howToExecute: acting
          ? "Send each leg in order through the Binance MCP server. Binance will ask the user " +
            "to confirm each one. Nothing has been placed by this server."
          : "Nothing to send. Ask again later, or call explain_decision to see why.",
      });
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "explain_decision",
    {
      title: "Why the last decision went that way",
      description:
        "Answers from the fact sheet the last verdict was actually made from, not from a fresh " +
        "look at the market. Use it for questions like 'why didn't you sell AVAX?'.",
      inputSchema: {
        question: z.string().max(300).optional().describe("Optional. Omitted returns the whole basis."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ question }) => {
      const state = await readState();
      const p = state.lastProposal;
      if (!p) return fail("No decision has been made yet. Call propose_rebalance first.");

      const signal = new Map(p.context.signals.map((s) => [s.symbol, s]));

      return json({
        question: question ?? null,
        decidedAt: p.at,
        verdict: p.timing.action,
        primaryFactor: p.timing.primaryFactor,
        reasoning: p.timing.reasoning,
        // Per position, everything that fed the call — so the answer to "why
        // not X" is the numbers for X rather than a second opinion.
        positions: p.context.portfolio.rows
          .filter((r) => r.symbol !== p.context.cashSymbol)
          .map((r) => {
            const s = signal.get(r.symbol);
            return {
              symbol: r.symbol,
              driftPp: Number(r.driftPp.toFixed(2)),
              bandPp: Number(r.bandPp.toFixed(2)),
              outsideBand: r.outsideBand,
              actedOn: p.orderedTrades.some((t) => t.symbol === r.symbol),
              declined: p.declined.some((c) => c.symbol === r.symbol),
              priceChange4hPct: s ? Number(s.priceChange4hPct.toFixed(2)) : null,
              priceChange24hPct: s ? Number(s.priceChange24hPct.toFixed(2)) : null,
              volRatio: s ? Number(s.volRatio.toFixed(2)) : null,
            };
          }),
        costBenefit: {
          estimatedCostUsd: Number(p.context.costBenefit.estimatedCostUsd.toFixed(2)),
          driftReductionPp: Number(p.context.costBenefit.driftReductionPp.toFixed(2)),
          costPerPpUsd: Number(p.context.costBenefit.costPerPpUsd.toFixed(2)),
        },
        declinedTrades: p.declined.map((c) => ({
          side: c.side,
          symbol: c.symbol,
          qty: c.qty,
          estNotionalUsd: Number(c.estNotionalUsd.toFixed(2)),
        })),
        readingNotes: [
          "A position inside its band was never a candidate, whatever its drift looks like.",
          "volRatio above ~1.5 means the last four hours are much more disordered than the day.",
          "Answer from these figures. Do not recompute them.",
        ],
      });
    },
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    "list_decisions",
    {
      title: "The decision log",
      description:
        "Every verdict this agent has reached, newest first: what it decided, the factor that " +
        "drove it, the drift at the time, and one line of reasoning. A sequence of HOLDs with " +
        "their reasons is the product's actual claim.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const decisions = await listDecisions(limit ?? 20);
      return json({
        count: decisions.length,
        decisions,
        summary: {
          holds: decisions.filter((d) => d.verdict === "HOLD").length,
          partials: decisions.filter((d) => d.verdict === "PARTIAL").length,
          rebalances: decisions.filter((d) => d.verdict === "REBALANCE").length,
          usedFallback: decisions.filter((d) => d.fellBack).length,
        },
      });
    },
  );

  return server;
}
