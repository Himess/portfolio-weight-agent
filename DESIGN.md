# Portfolio Weight Agent — Design Spec

**Hackathon:** Binance Agent OS Mini Hackathon, Track A
**Deadline:** 2026-09-08 23:59 UTC
**Goal:** 1st place. Ship complete, not clever.

---

## 1. The product in one line

> **Selling your winners and buying your losers is psychologically hard. The agent proposes it; you approve it.**

The user declares a target allocation once. The market moves. The agent watches the drift, decides
whether acting is worth it right now, proposes the exact trades with a reason, and the user approves.

Long-horizon traders are the audience — people who have a view ("I want 40% BTC, 20% L1s") but who
will not execute the unpleasant discipline that view requires.

---

## 2. Non-negotiable architectural principle

**The LLM selects and explains. It never computes.**

Every number that reaches the user or an order — quantities, prices, drift percentages, notional
values — comes from deterministic code. The LLM receives precomputed options and picks among them.

Why this is load-bearing:

- A number the LLM invented could reach a live order. Unacceptable.
- Deterministic math is reproducible; the same portfolio always yields the same drift table. Users
  with real money will not trust a system that gives different figures on each run.
- It makes the "is this an agent or a bot?" question answerable with a straight face: the reasoning
  is genuinely non-deterministic, the arithmetic genuinely is not.

If the LLM returns a quantity, **reject the response and fall back to the deterministic default.**

---

## 3. Platform constraints (verified — do not design around these, design *with* them)

From `https://developers.binance.com/en/docs/agent-native/mcp-server/agentic`:

| Constraint | Consequence for us |
|---|---|
| Every trade/transfer requires user confirmation. Applies to every non-read action. | **This is our UX, not our obstacle.** The product is a proposer. Never attempt to bypass. |
| MCP is OAuth-gated, desktop-bound. No headless/server path. | No 24/7 daemon. The agent runs when the user runs it. Design as an on-demand review, not a background service. |
| Market data scope is public, needs no auth. | The entire read/analysis path can be built and demoed before OAuth works. Build here first. |
| Scopes: Market data, Account, Trade, Transfer. | Transfer is only *between wallets inside the agentic sub-account*. No pulling from main. |
| No withdrawal scope exists. | Nothing to defend against. Say so in the README. |
| Sub-account is funded manually by the user. | Demo funding is a manual prerequisite. Do it early. |
| Optional read-only view of the main account. | Use it: show true total exposure even though we only trade the sub-account. |
| Trade coverage: Spot, Margin, Convert, USDⓈ-M Futures, COIN-M Futures. | We use **Spot and Convert only**. Futures is out of scope. |
| Emergency stop lives in the Binance web UI, not callable by the agent. | Link to it in the UI. Don't fake one. |
| **Concrete MCP tool names are not documented anywhere.** | Discovery step required (§9). Do not hardcode tool names before you have seen `tools/list`. |

---

## 4. Data model

```ts
type Holding = { symbol: string; qty: number; priceUsd: number; valueUsd: number };

type TargetLeaf   = { kind: "asset";  symbol: string; weight: number };   // weight of total NAV
type TargetBasket = {
  kind: "basket";
  label: string;                 // user's words: "L1s", "AI tokens"
  weight: number;                // weight of total NAV
  members: { symbol: string; weight: number }[];  // intra-basket, sums to 1
  resolvedAt: string;            // pinned once approved — see §7.3
  rationale: string;
};

type Allocation = { targets: (TargetLeaf | TargetBasket)[]; cashSymbol: string /* "USDT" */ };

type DriftRow = {
  symbol: string;
  targetWeight: number;   // 0..1
  currentWeight: number;
  driftPp: number;        // (current - target) * 100, signed, percentage points
  deltaUsd: number;       // target_value - current_value; >0 means BUY
  outsideBand: boolean;
};
```

**Invariant:** all target weights sum to exactly 1.0. Validate on input, reject otherwise.

---

## 5. Deterministic core

Build this first. It must work with zero LLM calls and zero authentication.

### 5.1 NAV

```
NAV = Σ (qty_i × price_i)   over sub-account spot balances (+ main account if read scope granted)
```

Prices from public market data. Cash (`USDT`) counts toward NAV at 1.0.

### 5.2 Drift

```
currentWeight_i = value_i / NAV
driftPp_i       = (currentWeight_i - targetWeight_i) × 100
totalDrift      = Σ |driftPp_i| / 2
```

`totalDrift` is the share of the portfolio that must change hands to return to target. Halving is
correct because positive and negative drifts always sum to the same magnitude. Display this as the
headline number.

### 5.3 Bands

```
band_i = max(absoluteFloorPp, relativeBandPct × targetWeight_i × 100)
outsideBand_i = |driftPp_i| > band_i
```

Defaults: `absoluteFloorPp = 2.0`, `relativeBandPct = 0.25`. So a 40% target has a ±10pp band; a 5%
target has a ±2pp floor band. This is deterministic. The LLM may *widen* bands via the timing
decision (§7.1); it may never narrow them.

> **Amended after measurement.** As specified, this is not the 5/25 rule it
> resembles: 5/25 takes the *lesser* of 5pp and 25% of the target weight, while
> `max(floor, relative)` takes the greater. A 50% position therefore got a
> ±12.5pp band, and `npm run bands` measured **one alert per year** on a majors
> portfolio over 8,760 real hourly bars. The implementation adds an optional
> `absoluteCapPp` and the tracking preferences now set floor/relative/cap
> together (`src/core/bands.ts`). The preference also previously reached only the
> timing prompt, so all three settings shared one band; it now sets the band
> itself.
>
> A second measurement then moved the numbers again. `npm run bands` sweeps band
> widths over the same year with real fees, real order-book slippage and the
> exchange filters applied, and shows that frequent correction is cheap in this
> product because only the *deviation* is traded: 822 corrections a year cost
> 0.26% of NAV and cut mean drift from 9.85pp to 0.30pp. The defaults were
> therefore paying for a caution the data does not support. The four rungs are
> now the measured rows — patient ±2.5pp (17/yr), balanced ±1.5pp (67/yr), tight
> ±0.75pp (267/yr), continuous ±0.4pp (822/yr) on a 40% position — and a fourth
> `continuous` preference was added for the "several times a day" case. The
> binding constraint is the human approval gate in §3, not cost.
>
> Third amendment: the band is no longer a constant. It scales with each asset's
> own realized volatility, `clamp((vol / 60%)^(2/3), 0.6, 2.5)` from 14 days of
> hourly closes, because a fixed percentage-point band tells you which of your
> assets is jumpiest rather than what has drifted. Measured volatility over the
> year was BTC 43%, ETH 60%, SUI 86%, TAO 100%, WLD 121%; on a volatile
> portfolio the scaling cuts interruptions ~30% for ~0.15pp of tracking. Still
> deterministic — §2 holds, the model picks no thresholds. And the timing
> decision now receives `askedLast24h`, so it can spend the owner's attention
> deliberately rather than proposing on every breach.


### 5.4 Candidate trade generation

```
targetValue_i = NAV × targetWeight_i
deltaUsd_i    = targetValue_i - currentValue_i
```

Then, in order:

1. Drop any `|deltaUsd_i| < minTradeUsd` (default 10).
2. Apply exchange filters from `exchangeInfo` per symbol: `LOT_SIZE` (step size), `MIN_NOTIONAL`,
   `PRICE_FILTER` tick size. Round quantities **down** to step size. Drop trades that fall below
   `MIN_NOTIONAL` after rounding.
3. **Sequence sells before buys** — buys need quote currency that sells produce.
4. Emit `CandidateTrade[]`, each with: side, symbol, qty, estimated notional, estimated fee,
   estimated slippage (walk the order book to the required depth), and `sequenceIndex`.

Slippage estimate: walk live order book levels until cumulative notional covers the trade; report the
volume-weighted execution price versus mid. This number matters — it is the main input to the
"is this worth doing" question.

---

## 6. Cost/benefit — the number the LLM reasons over

For each candidate rebalance, compute deterministically:

```
estimatedCostUsd    = Σ (fee_i + slippage_i)
driftReductionPp    = totalDrift_before - totalDrift_after
costPerPpUsd        = estimatedCostUsd / max(driftReductionPp, 0.01)
```

Also compute, per drifting asset:

- `realizedVol24h` — stdev of hourly returns over 24h, annualized or raw, be consistent
- `realizedVol4h`
- `volRatio = realizedVol4h / realizedVol24h` — the "is this move still happening" signal
- `priceChange4h`, `priceChange24h`
- `daysSinceLastRebalance`

These go into the LLM prompt as facts. The LLM does not recompute them.

---

## 7. The judgment layer (LLM)

Four decisions. Each has a strict JSON schema. **Validate every response; on schema failure, log it
and fall back to the deterministic default.**

Use `claude-sonnet-4-6`. Temperature low (0.2) for 7.1–7.3, higher (0.7) for 7.4.

### 7.1 Timing — "should we act now?"

**This is the decision that makes it an agent.** A bot rebalances because a threshold was crossed.

**Input:** drift table, cost/benefit numbers, volatility figures, price action, days since last
rebalance, user's stated preference (`patient` | `balanced` | `tight`).

**Output schema:**

```json
{
  "action": "REBALANCE" | "PARTIAL" | "HOLD",
  "assetsToActOn": ["BTC", "ETH"],
  "reasoning": "string, 2-4 sentences, user-facing",
  "primaryFactor": "cost" | "volatility" | "falling_knife" | "drift_magnitude" | "staleness"
}
```

`assetsToActOn` must be a subset of symbols already flagged `outsideBand` by §5.3. Reject otherwise.

**The HOLD case must be reachable and must be demonstrated.** Legitimate reasons to hold:

- The move causing the drift is still in progress (`volRatio` >= 1.5 and a 4h move >= 3% in the
  direction of the drift) — buying into it is catching a falling knife. Both thresholds are
  measured rather than chosen (`npm run knife`, two windows); the reasoning, including what the
  measurement does *not* support, is in the comment on `isMoveInProgress`.
- `costPerPpUsd` is high relative to portfolio size — the cure costs more than the disease.
- The whole market moved together; absolute values changed but relative weights barely did.
- Volatility spike means bands should be temporarily wider.

> A bot can never say "do nothing today." Make sure yours can, and make sure the demo shows it.

### 7.2 Execution path — "which legs, in what order?"

**Input:** the candidate trades, order book depth per symbol, fee schedule, available quote balances,
whether Convert is available for the pair.

**Output schema:**

```json
{
  "orderedTrades": [
    { "candidateId": "t3", "method": "spot_market" | "spot_limit" | "convert",
      "limitPriceOffsetBps": 0, "why": "string" }
  ],
  "droppedCandidates": [ { "candidateId": "t5", "why": "string" } ]
}
```

`candidateId` must reference a trade produced in §5.4. **The LLM cannot invent a trade or change a
quantity.** It selects, orders, drops, and chooses execution method only.

### 7.3 Basket resolution — "what is an L1?"

The user types a category. The agent turns it into symbols and defends the choice.

**Input:** user's phrase, tradable symbol list from `exchangeInfo`, 24h quote volume per symbol.

**Output schema:**

```json
{
  "members": [ { "symbol": "SOL", "weight": 0.3, "why": "string" } ],
  "excluded": [ { "symbol": "MATIC", "why": "string" } ],
  "rationale": "string",
  "confidence": "high" | "medium" | "low"
}
```

Rules:
- Every symbol must exist in `exchangeInfo` and be tradable against the cash symbol. Filter out
  anything that isn't — do not trust the model on symbol existence.
- Weights must sum to 1.0 (normalize if within tolerance, reject if wildly off).
- **The user reviews and edits before it is saved.** Once approved, `resolvedAt` is set and the basket
  is **pinned** — it does not re-resolve on later runs. Silent membership changes would destroy trust.
  Offer an explicit "re-resolve this basket" button.

This is the feature no exchange UI has. Give it real screen space.

### 7.4 Narrative

Turn the approved plan into the sentences the user reads. Input is the full decision context; output
is prose. **Every figure in the prose must be substituted from the deterministic layer** — pass
numbers in as template values rather than letting the model retype them.

---

## 8. Replay harness — build this on day one

The demo depends on market conditions you cannot schedule. Do not gamble on the live market
producing a good moment during recording.

**Build:**

1. Pull historical klines for the portfolio symbols over a chosen window (a real drawdown, a real
   alt rally).
2. Given an initial holding set, reconstruct NAV and weights at each step.
3. Step forward at configurable speed; run the full agent loop at intervals.
4. Log every decision with its inputs.

This gives you: a reliable demo, the ability to *find* a window where HOLD fires naturally, and a
sanity check that the drift math is right. It is demo insurance and a debugging tool at once.

**Do not skip this to save time. It is the single highest-leverage piece of the build.**

---

## 9. Binance integration

### 9.1 Adapter interface

Everything talks to one interface with three implementations:

```ts
interface MarketAdapter {
  getPrices(symbols: string[]): Promise<Record<string, number>>;
  getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]>;
  getOrderBook(symbol: string, depth: number): Promise<OrderBook>;
  getExchangeInfo(): Promise<ExchangeInfo>;
}
interface AccountAdapter { getBalances(): Promise<Holding[]>; }
interface TradeAdapter   { placeOrder(t: OrderedTrade): Promise<OrderResult>; }
```

Implementations: `ReplayAdapter` (historical), `PublicAdapter` (public market data, no auth),
`McpAdapter` (live, OAuth). Build and test against the first two; swap in the third last.

### 9.2 Tool discovery — required, because names are undocumented

Do not hardcode MCP tool names. Once OAuth is connected in the client:

1. Call `tools/list`. Log the full response verbatim into `docs/mcp-tools.json` — commit it. It is
   itself a contribution, since Binance has not published this.
2. Write `McpAdapter` against the observed names.
3. If a needed capability is missing, degrade gracefully: the read/analysis path still works on
   public market data, and the app shows the plan without being able to place the order.

### 9.3 Order placement

Hand `orderedTrades` to the MCP one at a time. Each surfaces for user confirmation — that is the
platform's design and our product's final step. Between orders, re-check that the next trade is still
valid (prices moved). If drift has changed materially, stop and re-plan rather than blindly
continuing the sequence.

**For the demo, one real small order is enough.** Do not risk the deadline on full execution.

---

## 10. UI

Four screens. Nothing more.

1. **Set allocation.** Add assets or type a category. Weights must sum to 100%. Show the basket
   resolution result for review and editing.
2. **Portfolio view.** Target vs current weight bar per asset, drift in pp, total drift as the
   headline, NAV. This is the screen that should be screenshot-worthy.
3. **Proposal.** The agent's decision — REBALANCE / PARTIAL / HOLD — with the reasoning, the trade
   list with quantities and estimated costs, and the cost/benefit line. Approve or dismiss.
4. **Confirmation handoff.** Each order going to Binance for the user's confirmation.

Design notes: the HOLD state needs its own visual treatment — it is a feature, not an empty state.
Make it look like a decision, not like nothing happened.

---

## 11. 36-hour schedule

| Block | Work |
|---|---|
| **H0–H2** | Repo, types, allocation model, weight validation. **Fund the sub-account now** — it's a manual step with latency. |
| **H2–H6** | `PublicAdapter`. NAV, drift, bands, candidate trades with exchange filters. Pure functions, unit-tested. |
| **H6–H10** | Cost/benefit: order book slippage walk, volatility figures. |
| **H10–H14** | **Replay harness.** Find a historical window where HOLD is the right call. |
| **H14–H20** | LLM layer: all four decisions, schemas, validators, fallbacks. |
| **H20–H26** | UI, all four screens. |
| **H26–H30** | OAuth + `tools/list` discovery + `McpAdapter` + one real small order end to end. |
| **H30–H33** | Record the demo. Multiple takes. |
| **H33–H36** | README, repo cleanup, submission, buffer. |

**Hard rule:** if OAuth integration is not working by H30, ship with the public-data path and show the
proposal step only. A complete product that cannot place the final order beats a broken one that can.

---

## 12. Demo script (~90 seconds)

1. **(0–15s)** User sets an allocation, typing "L1s" as one line. Agent resolves it to symbols with a
   rationale. User edits one, approves.
2. **(15–30s)** Portfolio view. Everything on target.
3. **(30–45s)** Time advances (replay). ETH rallies. Drift appears — now overweight ETH.
4. **(45–60s)** Agent proposes: sell a little ETH, buy the underweight names. Reasoning shown.
   **Narrate the point:** it is selling the thing that just went up.
5. **(60–75s)** **The HOLD scene.** Later, a sharp drop creates larger drift — and the agent declines
   to act, explaining that the move is still in progress. *This is the shot that proves it isn't a
   bot.* Give it room.
6. **(75–90s)** Approve a real proposal → Binance confirmation dialog → filled order.

Close on the one-liner: selling winners and buying losers is hard; the agent proposes, you approve.

---

## 13. Out of scope — do not build

Multiple portfolios · historical performance tracking · scheduled/background runs · futures or hedging
· tax lots · backtesting UI · mobile · auth/accounts · anything requiring B402 merchant credentials ·
any attempt to bypass the confirmation gate.

---

## 14. README requirements

- The one-line thesis, up top.
- Which Agent OS pieces are used and why: MCP market data (public), account read, spot trade,
  optionally the read-only main-account view.
- **The agent/bot distinction, stated plainly:** deterministic math, non-deterministic judgment. Say
  what the LLM decides and what it is structurally prevented from deciding.
- `docs/mcp-tools.json` — the observed tool list, offered as a contribution since it isn't published.
- Explicit statement: **this is not investment advice, the user is the decision-maker, and every order
  requires user confirmation.** Binance's own framing puts responsibility on the user; match it.
- A way to reach every screen, the HOLD included. Reproduction beats a screenshot here: a picture
  of a HOLD is trivial to fake and the whole product rests on it, so the replay harness renders
  the real one from the same dataset and bar instead.

---

## 15. Submission checklist

- [ ] Follow `@Binance` and repost the announcement
- [ ] Reply or quote-repost with the video/demo **and** the GitHub link
- [ ] Complete the survey (linked from the hackathon blog post)
- [ ] Confirm before **2026-09-08 23:59 UTC**

Track A pays $2,000 / $1,500 / $1,000 for the top three, and $300 each to the next 50. A finished,
well-explained submission clears the bar for the tail comfortably; the top three come down to the
HOLD scene and the basket-resolution feature. Both are in the plan — protect them if time gets short.
