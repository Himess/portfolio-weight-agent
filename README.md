# Portfolio Weight Agent

**Selling your winners and buying your losers is psychologically hard. The agent proposes it; you approve it.**

You declare a target allocation once. The market moves. The agent watches the drift, decides whether
acting is worth it *right now*, proposes the exact trades with a reason, and you approve.

Built for the Binance Agent OS Mini Hackathon, Track A.

---

## The distinction that matters: agent, not bot

**The LLM selects and explains. It never computes.**

Every number that reaches you or an order — quantities, prices, drift percentages, notional values,
costs — comes from deterministic TypeScript. The model receives precomputed options and picks among
them.

| The model decides | The model is structurally prevented from deciding |
|---|---|
| Whether to act now, or wait (`REBALANCE` / `PARTIAL` / `HOLD`) | Any quantity, price, or percentage |
| Which drifting assets to act on | Which assets *count* as drifting — bands are computed |
| The order of the legs and the execution method | That sells come before buys — enforced after the fact |
| Which category members belong in a basket | Whether a symbol exists or is tradable — checked against the live universe |
| The words you read | The figures inside those words — substituted from the deterministic layer |

This is enforced, not merely requested:

- **Timing** — `assetsToActOn` must be a subset of the symbols the band rule actually flagged. If
  the model names anything else, the response is rejected and the deterministic default is used.
- **Execution** — the model returns `candidateId`s, never sizes. Quantities are read back from our
  own candidate set. A hallucinated id yields no trade. Sells-before-buys is re-imposed on the result.
- **Baskets** — every returned symbol is checked against the live tradable universe and dropped if
  absent. Weights are normalized only if already within tolerance of 1.0; a wildly wrong set is
  rejected rather than silently rescaled.
- **Narrative** — the model writes `{{PLACEHOLDER}}` tokens, and we substitute real figures. Before
  substituting, the raw output is scanned for any bare `$`, `%`, `pp` or `bps` figure it typed
  itself; if it typed one, the whole response is discarded and a deterministic template is rendered.

Every fallback is visible in the UI, labelled *"deterministic fallback — no judgment applied"*.
See `tests/guardrails.test.ts` — all of the above is tested without an API key.

### HOLD is a feature

A bot rebalances because a threshold was crossed. This one can decline:

- the move that created the drift is still in progress (buying a falling knife),
- the correction costs more than the drift it removes,
- the whole market moved together, so absolute values changed but relative weights barely did,
- volatility spiked, so today's bands should effectively be wider.

`HOLD` has its own visual treatment — it is a decision, not an empty state.

---

## Which Agent OS pieces this uses, and why

| Piece | Used for | Why |
|---|---|---|
| **MCP market data** (public, no auth) | prices, klines, order-book depth, exchange filters | The entire read/analysis path needs no OAuth, so it works before any credential exists. Real depth is what makes the slippage estimate — and therefore the cost/benefit call — honest. |
| **MCP account scope** | reading sub-account balances | So the drift table reflects a real portfolio. Optional: holdings can be entered by hand. |
| **MCP trade scope** (Spot, Convert) | placing the approved orders | One at a time, each surfaced by Binance for your confirmation. |
| **MCP read-only main account** | true total exposure | We only trade the Agentic sub-account, but you should see the whole picture. |

Deliberately **not** used: Futures, Margin (out of scope — this is a long-horizon spot product),
Transfer (nothing to move), and anything requiring B402 merchant credentials.

There is **no withdrawal scope in the Binance MCP server** — funds cannot leave your account through
this app, because the platform provides no mechanism for it. Nothing to defend against.

---

## `docs/mcp-tools.json` — a small contribution

Binance does not publish the MCP server's tool names or parameters anywhere in its documentation.
This repo therefore **discovers them at runtime rather than hardcoding them**, and commits what it
finds.

`npm run mcp:discover` records the server's live response verbatim. Without a bearer token it
captures the OAuth metadata and the 401 challenge — already useful, and reproducible by anyone:

```jsonc
{
  "grant_types_supported": ["authorization_code"],       // no client_credentials:
  "code_challenge_methods_supported": ["S256"],          // no headless/server path
  "token_endpoint_auth_methods_supported": ["none"]
}
```

With `BINANCE_MCP_TOKEN` set it captures the full `tools/list` output. `src/adapters/mcp.ts` then
resolves capabilities by matching discovered names — so it keeps working if Binance renames a tool,
and degrades gracefully (showing the plan, unable to send it) if a capability is missing.

---

## Running it

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY to turn on the judgment layer
npm run env:check         # confirms the key is actually being loaded
npm run klines -- --symbols BTC,ETH,SOL,AVAX --days 365 --out data/window-365d.json
npm run dev
```

### The judgment layer runs on any provider — including free ones

The four decisions all have the same shape: a system prompt plus precomputed JSON facts in, schema-
conforming JSON out. Nothing about that needs a specific vendor, so `src/llm/provider.ts` is the only
file that names one. Set **one** key in `.env`:

| Provider | Cost | Key |
|---|---|---|
| **Google Gemini** | **free tier, no card** — see the quota note below | <https://aistudio.google.com/apikey> |
| Groq | free tier | <https://console.groq.com/keys> |
| OpenRouter | some models free (`:free` suffix) | <https://openrouter.ai/keys> |
| Anthropic | paid — what DESIGN.md specifies | <https://console.anthropic.com/settings/keys> |
| Ollama | free, local | no key; set `LLM_BASE_URL=http://localhost:11434/v1` |

A review costs four calls, so the free tiers are ample. Everything except Anthropic goes through the
OpenAI-compatible backend, so any other compatible endpoint works too.

> A claude.ai Pro/Max subscription does **not** include API access — the Anthropic Console is a
> separate account with its own credit. Running the app on a server does not change that: where the
> code runs does not determine which credentials you are licensed to use.

> **Gemini free-tier quota is per model, per day, and varies a lot.** `gemini-2.5-flash` allows only
> **20 requests/day** — one validation run exhausts it. The default here is `gemini-flash-lite-latest`,
> which is the generous tier; the `-latest` alias also survives model retirement (`gemini-2.0-flash`
> and `gemini-2.5-flash-lite` already 404 on this endpoint). Override with `LLM_MODEL`.

```bash
npm run env:check            # which provider resolved, key masked
npm run llm:check -- --n 10  # 10 calls per decision, reports the schema-pass rate
```

`llm:check` is the measurement that matters. Whatever the provider returns is validated against the
zod schema *and* against facts the model does not get to assert; anything that fails becomes a
labelled deterministic fallback. A decision falling back more than about once in ten means the prompt
needs work — that is a prompt problem, not a safety problem, because a bad response can never reach
an order.

**Measured** — `gemini-flash-lite-latest`, free tier, 10 calls per decision:

| Decision | Schema-pass |
|---|---|
| §7.1 timing | 10/10 |
| §7.2 execution | 10/10 |
| §7.3 basket resolution | 10/10 |
| §7.4 narrative | 10/10 |

The narrative result is worth spelling out, because it is the claim most people would assume is
hand-waving. Raw model output, before substitution:

> Rebalancing AVAX after market drop
>
> Your portfolio drifted by `{{TOTAL_DRIFT}}` due to recent market moves. We are buying AVAX while it
> is down to bring your allocation back in line for `{{EST_COST}}`.

Placeholders emitted: `{{TOTAL_DRIFT}}`, `{{EST_COST}}`. Bare figures typed by the model: **none**.

### The HOLD, captured

`docs/hold-example.json` holds a real HOLD from the judgment layer — not the deterministic fallback,
which the capture script rejects. Reproduce with `npm run hold:example`.

Replay bar 393 (2025-09-23). AVAX is **+4.9pp against a 3.8pp band**, so a threshold bot trades here.
The agent did not, and the deterministic facts say why: `volRatio` 1.93, 4h `+3.2%`, 24h `+9.9%` —
AVAX is overweight *and still climbing*, so correcting now means selling into a move that has not
finished. One candidate trade, already sized and priced, was declined.

> Holding steady despite drift
>
> Your portfolio shows a total drift of 4.9pp led by AVAX currently at 19.9%, but active upward
> momentum means we are holding off on trades today. Selling into this rapid climb would be
> premature, so we wait for the price action to settle before acting.

`primaryFactor: falling_knife`. That is the whole product in one screen: a bot cannot say
"do nothing today", and this can, with its reasons on the table.

`.env` is gitignored. Next.js loads it automatically; the `tsx` scripts load it via
`--env-file-if-exists`, which is why `npm run replay` and `npm run llm:check` see it too.

Open http://localhost:3000. Four screens: set allocation → portfolio → proposal → confirmation handoff.

**It runs without an API key.** All the arithmetic, the drift table, the candidate trades and the
cost/benefit still work; the agent falls back to the plain band rule and says so. Adding a key turns
on the timing judgment, basket resolution, and the written narrative.

### The replay harness

The demo cannot depend on the live market producing a good moment. `npm run klines` captures a real
historical window; the replay adapter then runs the *identical* agent loop against it with time as a
cursor.

```bash
# Find the moments worth demoing — deterministic, no LLM calls, no tokens spent
npm run replay -- --data data/window-365d.json --scan

# Run the full loop across a window, applying fills so each step sees the last one's consequences
npm run replay -- --data data/window-365d.json --from 30 --to 8759 --every 720
```

`--scan` reports where drift crosses a band and where a move is still in progress — i.e. exactly
where `HOLD` is the correct call. On a real BTC/ETH/SOL/AVAX year (2025-09 → 2026-09) it finds
**122 such bars**, with drift reaching 12.5pp as AVAX fell 68.8% against BTC's 27.7%.

That window is also the honest version of the pitch: the agent proposes **buying AVAX**, the asset
that lost two thirds of its value. That is the trade people cannot make themselves.

---

## What the interface does

Four screens; three of them carry the product.

**Allocate.** A live token picker over the full Binance USDT universe — 250 pairs
ordered by real 24h volume, with real price and change, official logos, and
sparklines drawn from real hourly closes. Search runs against the exchange, not a
curated list: typing `sol` returns SOL, SOLV and BNSOL.

That last detail is why there is a safety layer rather than a contract-address
column. This app trades **spot pairs, not on-chain tokens** — no contract is
involved in a spot order, BTC has no ERC-20 address, ETH is native, and a
contract column would be empty or arbitrary for the largest holdings while
implying the app trades that on-chain token. The hazards that *do* apply here are
measurable from live data, so `src/lib/safety.ts` flags them:

| Badge | Means | Derived from |
|---|---|---|
| `like SOL` | reads like a much larger ticker | one symbol contains the other **and** the other has >20× the volume |
| `thin` | your own order will move the price | 24h quote volume below the tier threshold |

Live result: SOL clean, SOLV and BNSOL both flagged on both counts. Deliberate
non-warnings are tested too — ARB and ARK merely share letters, and two
comparable-volume names are not a trap.

Your allocation is saved locally and restored on return, with a banner saying so
and one click back to defaults. Nothing leaves the browser.

**Portfolio.** Total drift is the largest thing on the page, because it decides
whether anything happens. The ring shows target on the outside and where you
actually are on the inside, both scaled against 100% so the mismatch is the thing
you see. Each position gets a deviation meter with its tolerance band drawn as a
region — which answers "outside, and which way" in a way a progress bar cannot.

**Proposal.** The decision, the reasoning, the cost, and a line naming what the
plan actually does: *"This buys AVAX while it is down 2.5% today — adding to a
loser, which is the part that feels wrong and is the point."* That is computed
from the traded assets' 24h change, and stays silent when the plan does not have
that shape.

**HOLD** gets its own layout — see below.

---

## How the numbers are computed

| Quantity | Definition |
|---|---|
| NAV | `Σ (qty × price)` over spot balances; cash at 1.0 |
| Drift | `(currentWeight − targetWeight) × 100`, in percentage points |
| **Total drift** | `Σ\|driftPp\| / 2` — halved because over- and under-weights always mirror each other, so the result is the share of the portfolio that must change hands |
| Band | `max(2.0pp, 25% × targetWeight × 100)` — a 40% target gets ±10pp, a 5% target gets the ±2pp floor |
| Slippage | walk real order-book levels to the required depth; VWAP vs mid |
| Cost/benefit | `estimatedCostUsd / max(driftReductionPp, 0.01)` — the price of one point of correction |
| `volRatio` | 4h vs 24h stdev of hourly log returns |

Two notes worth having in writing, because both caused a real bug during the build:

- **Total drift is an aggregate; bands are per position.** A 7.6pp total drift can coexist with
  *nothing* worth trading, because it is spread thin. The UI says so explicitly rather than showing
  a big number next to "no action" and looking broken.
- **`volRatio` measures disorder, not trend.** A smooth strong ramp has *low* return variance, and
  mixing a calm stretch with a spike inflates the 24h denominator. So it is never used alone —
  `priceChange4h` carries direction and magnitude, and the falling-knife call needs both.

---

## Architecture

```
src/core/       pure functions — drift, bands, candidates, slippage, signals, cost/benefit
src/adapters/   PublicAdapter (no auth) · ReplayAdapter (historical) · McpAdapter (OAuth)
src/llm/        four decisions, each with a strict schema, a validator, and a deterministic fallback
src/agent.ts    the loop: drift → candidates → cost/benefit → timing → execution → narrative
src/app/        four screens
scripts/        klines capture · replay harness · MCP tool discovery
tests/          48 tests, no API key required
```

Everything talks to one adapter interface with three implementations, so the replay harness, the
public-data path and the live MCP path exercise identical logic.

```bash
npm test        # 48 tests
npm run typecheck
npm run build
```

---

## Screenshots

Reproduce with `npm run dev` after capturing a dataset:

| State | How to reach it |
|---|---|
| Portfolio view | Replay source, seed bar 30, review bar 8759 → **Review my portfolio** |
| Proposal (REBALANCE) | …then **See what the agent decided** |
| Proposal (HOLD) | Requires `ANTHROPIC_API_KEY`. Run `npm run replay -- --data data/window-365d.json --scan`, pick a bar from a *"move still in progress"* run, and set it as the review bar. |

> Screenshot files are not committed yet — capture them into `docs/screenshots/` before submitting.
> The `HOLD` shot is the one that proves the product is not a bot; give it room in the demo.

---

## Limitations, stated plainly

- **No background runs.** The Binance MCP server is OAuth-gated with no `client_credentials` grant,
  so there is no headless path. This is an on-demand review, not a daemon — by design, not omission.
- **Replay slippage is modelled.** Historical order-book depth is not available, so replay uses a
  synthetic book with a fixed spread and linear impact. Live mode uses real depth. The UI says which.
- **Convert is offered as an execution method but not separately priced.** Its quote is treated as
  equivalent to a market order for cost purposes.
- **Baskets are pinned at approval** and never re-resolve on their own. Silent membership changes
  would destroy trust. Re-resolve explicitly if you want to.

---

## Disclosures

**This is not investment advice.** You are the decision-maker. The agent proposes; nothing executes
without you. Every order requires your confirmation in Binance before it executes, and this
application cannot bypass that gate — nor does it try to. There is no withdrawal scope, so funds
cannot leave your account through this tool.

AI can make mistakes, act on stale information, or send incorrect parameters. Verify every order
before confirming it. Trading digital assets carries substantial risk, including total loss.

Binance's own framing puts responsibility on the user. This project matches it.
