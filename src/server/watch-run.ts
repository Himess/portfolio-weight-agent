/**
 * One pass over every registered watch.
 *
 * The order of operations is the whole design. Drift is arithmetic on live
 * prices, so it is computed for every watch on every scan and costs nothing.
 * The judgment call — is now a good moment, or is this a falling knife — costs
 * an LLM request, so it only runs for a portfolio that has actually crossed a
 * band. A watch that is inside its bands never reaches the model at all.
 *
 * That is also why the alert is worth reading: it does not say "you have
 * drifted 8 points", which the user could have computed. It says what the agent
 * concluded about it, including the conclusion to wait.
 */

import { runReview } from "../agent";
import { askBudgetFor, bandsFor, volScales } from "../core/bands";
import { buildHoldings, computeDrift } from "../core/drift";
import { allocationSymbols } from "../core/allocation";
import { breachedSymbols, shouldNotify, signatureOf, type WatchVerdict } from "../lib/watch";
import { composeMessage } from "../lib/watch-message";
import { appUrl } from "./app-url";
import { sendMessage, telegramConfigured } from "./telegram";
import { publicAdapter } from "./session";
import { watchStore, type WatchRecord } from "./watch-store";
import type { Kline, PortfolioState } from "../types";

/**
 * A cap on how many watches may reach the model in one run. The free Gemini
 * tier is a few dozen requests a day; without a ceiling, one busy market
 * morning would spend the whole quota in a single scan and every later watch
 * would fall back. Deferred watches are simply picked up on the next run.
 */
const MAX_JUDGMENTS_PER_RUN = 5;

/**
 * How long the same breach may go un-rejudged.
 *
 * Bands are tight enough now that a drifting portfolio can be outside them for
 * hours at a stretch, and an hourly scan would then spend an LLM request every
 * hour re-deciding an unchanged situation. This bounds that to six a day per
 * watch without ever delaying something new: a *different* set of assets
 * breaching is judged immediately, because that is a genuinely new question.
 *
 * The cost of the throttle is that a HOLD -> REBALANCE flip on an unchanged
 * breach can be up to this late. That is the right trade: the alternative is a
 * free tier exhausted by lunchtime, after which every verdict is a fallback.
 */
const MIN_HOURS_BETWEEN_JUDGMENTS = 4;

export type WatchOutcome = {
  id: string;
  label: string | null;
  /**
   * What this scan concluded. The two extra values are not verdicts about the
   * portfolio — they say the scan did not reach one, which a log that reported
   * them as IN_BAND would have hidden.
   */
  verdict: WatchVerdict | "DEFERRED" | "FAILED";
  breached: string[];
  totalDriftPp: number;
  navUsd: number;
  sent: boolean;
  why: string;
  error?: string;
};

export type ScanResult = {
  scanned: number;
  judged: number;
  sent: number;
  outcomes: WatchOutcome[];
};

/** Messages sent to this chat in the last 24 hours. */
function recentAsks(watch: WatchRecord): string[] {
  const cutoff = Date.now() - 86_400_000;
  return (watch.notifiedAt ?? []).filter((t) => Date.parse(t) >= cutoff);
}

/** Price a watch's holdings and compute drift. No LLM, no network beyond prices. */
async function stateFor(watch: WatchRecord): Promise<PortfolioState> {
  const market = publicAdapter();
  const symbols = [
    ...new Set([...allocationSymbols(watch.allocation), ...Object.keys(watch.quantities)]),
  ];
  const prices = await market.getPrices(symbols);
  const holdings = buildHoldings(watch.quantities, prices, watch.allocation.cashSymbol);

  // Volatility-scaled exactly as the app does it. An alert that fired on a
  // different threshold than the screen would be an alert the owner distrusts.
  const history: Record<string, Kline[]> = {};
  await Promise.all(
    symbols
      .filter((s) => s !== watch.allocation.cashSymbol)
      .map(async (symbol) => {
        try {
          history[symbol] = await market.getKlines(symbol, "1h", 336);
        } catch {
          /* no history, no scaling — same as the fixed band */
        }
      }),
  );

  return computeDrift(holdings, watch.allocation, {
    bands: bandsFor(watch.preference),
    volScale: volScales(history),
  });
}

async function runOne(watch: WatchRecord, budget: { left: number }): Promise<WatchOutcome> {
  const store = watchStore();
  const base: WatchOutcome = {
    id: watch.id,
    label: watch.label,
    verdict: "IN_BAND",
    breached: [],
    totalDriftPp: 0,
    navUsd: 0,
    sent: false,
    why: "",
  };

  const state = await stateFor(watch);
  const breached = breachedSymbols(state, watch.allocation.cashSymbol);
  base.breached = breached;
  base.totalDriftPp = state.totalDriftPp;
  base.navUsd = state.navUsd;

  let verdict: WatchVerdict = "IN_BAND";
  let narrative = "";
  let fellBack = false;
  let judged = false;

  if (breached.length > 0) {
    // Same assets as last time, and judged recently? Nothing new has been
    // asked, so do not pay to ask it again.
    const sameAsLast = watch.lastSignature?.endsWith(`:${breached.join(",")}`) === true;
    const hoursSinceJudged = watch.lastJudgedAt
      ? (Date.now() - Date.parse(watch.lastJudgedAt)) / 3_600_000
      : Infinity;
    if (sameAsLast && hoursSinceJudged < MIN_HOURS_BETWEEN_JUDGMENTS) {
      const updated: WatchRecord = { ...watch, lastCheckedAt: new Date().toISOString() };
      await store.put(updated);
      return {
        ...base,
        verdict: "DEFERRED",
        why: `unchanged breach, last judged ${hoursSinceJudged.toFixed(1)}h ago`,
      };
    }

    if (budget.left <= 0) {
      // Out of judgment budget for this run. Say nothing rather than send a
      // drift number dressed up as a decision; the next run will pick it up.
      return { ...base, verdict: "DEFERRED", why: "judgment budget spent this run" };
    }
    budget.left -= 1;

    const proposal = await runReview({
      market: publicAdapter(),
      allocation: watch.allocation,
      quantities: watch.quantities,
      preference: watch.preference,
      daysSinceLastRebalance: watch.lastNotifiedAt
        ? Math.floor((Date.now() - Date.parse(watch.lastNotifiedAt)) / 86_400_000)
        : null,
      // How often this chat has already been interrupted today. The agent is
      // told, so a volatile morning can end in one message rather than six.
      askedLast24h: recentAsks(watch).length,
    });
    verdict = proposal.timing.action;
    narrative = proposal.narrative;
    fellBack = proposal.timing.fellBack === true;
    judged = true;
  }

  base.verdict = verdict;

  const signature = { verdict, assets: breached };
  const decision = shouldNotify({
    signature,
    lastSignature: watch.lastSignature,
    lastNotifiedAt: watch.lastNotifiedAt,
    repeatAfterHours: watch.repeatAfterHours,
    paused: watch.paused,
    bound: watch.chatId != null,
    now: Date.now(),
    sentAt: watch.notifiedAt,
    dailyAskBudget: askBudgetFor(watch.preference),
  });
  base.why = decision.why;

  const updated: WatchRecord = {
    ...watch,
    lastCheckedAt: new Date().toISOString(),
    lastVerdict: verdict,
    ...(judged ? { lastJudgedAt: new Date().toISOString() } : {}),
  };

  if (!decision.send || watch.chatId == null) {
    // The signature still advances: a situation we chose not to report is still
    // the situation we have seen, or the next scan would treat it as new.
    updated.lastSignature = signatureOf(signature);
    await store.put(updated);
    return base;
  }

  const text = composeMessage({
    label: watch.label,
    preference: watch.preference,
    state,
    breached,
    verdict,
    narrative,
    fellBack,
  });

  const result = await sendMessage(watch.chatId, text, [
    { text: "Open the agent", url: appUrl() },
  ]);

  if (result.ok) {
    const now = new Date().toISOString();
    updated.lastSignature = signatureOf(signature);
    updated.lastNotifiedAt = now;
    // Bounded: only the last day matters, so the list cannot grow.
    updated.notifiedAt = [...recentAsks(watch), now];
    base.sent = true;
  } else {
    base.error = result.error;
    // Blocked means the chat is gone for good. Unbind rather than retrying
    // forever, and keep the watch so the same link can be re-bound later.
    if (result.blocked) {
      updated.chatId = null;
      updated.boundAt = null;
      base.why = "chat blocked the bot — unbound";
    }
  }

  await store.put(updated);
  return base;
}

export async function runScan(): Promise<ScanResult> {
  if (!telegramConfigured()) {
    return { scanned: 0, judged: 0, sent: 0, outcomes: [] };
  }

  const watches = await watchStore().all();
  const active = watches.filter((w) => w.chatId != null && !w.paused);
  const budget = { left: MAX_JUDGMENTS_PER_RUN };
  const outcomes: WatchOutcome[] = [];

  // Sequential on purpose. These share one Binance rate-limit budget and one
  // LLM quota, and a scan is not latency-sensitive.
  for (const watch of active) {
    try {
      outcomes.push(await runOne(watch, budget));
    } catch (err) {
      outcomes.push({
        id: watch.id,
        label: watch.label,
        verdict: "FAILED",
        breached: [],
        totalDriftPp: 0,
        navUsd: 0,
        sent: false,
        why: "scan failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    scanned: active.length,
    judged: MAX_JUDGMENTS_PER_RUN - budget.left,
    sent: outcomes.filter((o) => o.sent).length,
    outcomes,
  };
}

/** A single watch, on demand — what `/check` in the chat runs. */
export async function checkNow(watch: WatchRecord): Promise<WatchOutcome> {
  return runOne(watch, { left: 1 });
}
