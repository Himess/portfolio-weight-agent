# Portfolio Weight Agent

**Selling your winners and buying your losers is psychologically hard. The agent proposes it; you approve it.**

You declare a target allocation once. The market moves. The agent watches the drift and decides
**which legs are worth correcting right now** — a threshold rule fires everything outside its band;
this one gave two positions opposite answers in the same check, buying BTC and declining to buy AVAX
while AVAX was still falling. It proposes the exact trades with a reason, and you approve.

It runs two ways, on one engine:

- **As an MCP server inside Claude Code**, beside Binance's own. Claude reads your real balances
  from Binance, hands them to this agent, and sends the plan back through Binance — which shows you
  its own confirmation dialog. This is the primary surface.
- **As a web app** at [portfolio-weight-agent.vercel.app](https://portfolio-weight-agent.vercel.app),
  the visual surface of the same decision.

Built for the Binance Agent OS Mini Hackathon, Track A.

---

## Run it inside Claude Code

Two MCP servers side by side: Binance's, for your account and your orders; this one, for the
decision. Neither can do the other's job, which is the point — this agent never sees a credential
and never places an order.

```bash
git clone https://github.com/Himess/portfolio-weight-agent && cd portfolio-weight-agent
npm install
```

`.mcp.json` is committed, so Claude Code offers both servers on first launch in the directory. Or
add them by hand:

```bash
claude mcp add portfolio-weight-agent -- node --env-file-if-exists=.env --import tsx src/mcp/stdio.ts
claude mcp add --transport http binance https://agent.binance.com/mcp/agentic
```

To try it without cloning, the same server is live over Streamable HTTP:

```bash
claude mcp add --transport http portfolio-weight-agent https://portfolio-weight-agent.vercel.app/api/mcp
```

Put a judgment key in `.env` (`GEMINI_API_KEY=…`, free, no card). Without one every deterministic
figure is still computed and the agent falls back to the plain band rule, labelled as such.

### The five tools

Captured from a live `tools/list` over stdio, not written by hand —
[`docs/mcp-agent-tools.json`](docs/mcp-agent-tools.json). Reproduce the whole session with
`npm run mcp:check`.

| Tool | What it does |
|---|---|
| `set_allocation` | Declare target weights once. A *category* like "AI tokens" is resolved to real symbols and returned with its rationale and exclusions to approve. Untradable symbols are rejected, never silently dropped. |
| `review_portfolio` | NAV, per-position drift, band, and what is outside it. Pure arithmetic on live prices — no model is consulted. |
| `propose_rebalance` | The full loop. Returns the verdict, the reasoning, **the fact sheet it was decided from**, and the ordered legs with exact quantities. On a HOLD it returns the trade it *declined*, sized and priced. |
| `explain_decision` | Answers from the stored fact sheet of the last verdict, not a fresh guess. "Why didn't you sell AVAX?" gets the numbers that actually drove the call. |
| `list_decisions` | The decision log. A sequence of HOLDs with their reasons is the claim; one screenshot is an anecdote. |

### How the pieces divide

| | Who does it | Why |
|---|---|---|
| Read balances | Binance MCP → passed in as `holdings` | This server holds no credential and cannot call Binance's MCP server; Claude Code is the orchestrator and holds both connections. |
| Market data | This server, directly | Binance's public endpoints need no auth. Deliberately not relayed through Claude: a model asked to carry a price will round it, and every downstream figure depends on it being exact. |
| Decide | This server | Deterministic math, then one model call to choose among precomputed options. |
| Place orders | Binance MCP, after **your** confirmation | There is no tool here that trades. |

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
| **MCP, as a server** | the agent itself | The decision is exposed as five tools so it can run beside Binance's own MCP server inside an AI client. That is what makes the account real: Claude Code is already a registered OAuth client, so there is no `client_id` to be issued by hand. |
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

Replay bar 393 (2025-09-23). AVAX is **+4.86pp against a 1.23pp band**, so a threshold bot trades
here. The agent did not, and the deterministic facts say why: `volRatio` 1.93, 4h `+3.2%`,
24h `+9.9%` — AVAX is overweight *and still climbing*, so correcting now means selling into a move
that has not finished. Candidate trades, already sized and priced, were declined.

> Holding steady on AVAX
>
> AVAX is still running hot with high volatility, so we are holding off on rebalancing today despite
> the 4.9pp drift. Letting momentum cool protects us from chasing the price while it surges. We will
> wait for the market to settle before trimming the position.

`primaryFactor: falling_knife`. That is the whole product in one screen: a bot cannot say
"do nothing today", and this can, with its reasons on the table.

One caveat stated rather than buried: re-running that bar gave HOLD once and PARTIAL on later runs.
The decision calls run at temperature 0 and Gemini's free tier still does not repeat itself, so a
marginal verdict is not reproducible. Every run picked `falling_knife` and every run declined to
sell AVAX — what varied was whether to also buy the two underweights while waiting. Every *number*
above is repeatable, because the model is not allowed to produce one.

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

**Allocate.** Type what you want instead of clicking it: *"remove SUI, add TAO at
12% and track more closely"* is one sentence and three controls. The model's only
job is turning that into edits from a fixed list — `src/core/commands.ts` then
applies them by arithmetic, checks every ticker against the live exchange, and
renders what actually changed as chips (`Removed SUI (was 10%)`, `Added TAO at
12%`). The chips come from the result, never from the model's prose, so if the
two ever disagree the chips are right. It works in whatever language you type in.

There is no instruction that trades. "Sell all my BTC" returns *unsupported* with
a sentence saying approval happens in Binance — reducing a target weight is an
edit, selling is an order, and orders are not something a sentence can do here.

Starting shapes for anyone who has not done this before — majors,
core-and-satellites, mostly-cash, and one built from Binance's tokenized US
equities (SPYB, QQQB, and a mega-cap tech basket). Offered as something to edit,
never as a recommendation, and each is checked against the live tradable universe
before it is shown, so a preset naming a delisted pair simply does not appear.

Below them, a live token picker over the full Binance USDT universe — 250 pairs
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

**Standing alerts.** The app can only tell you something when you open it, and
drift happens while you are not looking. A watch messages you in Telegram when
the allocation crosses a band — carrying the agent's verdict, including the
verdict to wait, which is the one a threshold bot can never send.

It fires on the same band the app draws on screen; there is no second, quieter
notification threshold to disagree with it. The owner sets that band, and the
app prints what the choice costs rather than three adjectives.

Those four settings are the measured rows of `npm run bands` — a year of real
hourly closes, checked every hour, with the 10bps taker fee and order-book
slippage applied to every fill:

| | base band on 30% | corrections/yr | cost/yr | mean drift |
|---|---|---|---|---|
| never | — | 0 | 0.00% | 10.76pp |
| patient | ±2.50pp | 18 | 0.04% | 2.38pp |
| balanced | ±1.50pp | 61 | 0.07% | 1.15pp |
| tight | ±0.75pp | 225 | 0.14% | 0.62pp |
| continuous | ±0.40pp | 717 | 0.27% | 0.34pp |

The volatility scaling applies to the floor and the relative term but **not the
cap**. The cap bounds the band on a large position — 25% of a 50% target is
12.5pp, which is not a tolerance — and that is a statement about position size,
not about volatility. Scaling it put volatile large positions back near the
number the cap was added to prevent. Measured both ways: leaving it alone gives
fewer interruptions and lower cost at every rung, with tracking within a
hundredth of a point (`npm run bands -- --scale-cap` to compare).

**The band is a baseline, not a constant.** It scales with each asset's own
realized volatility — `volScale = clamp((vol / 60%)^(2/3), 0.6, 2.5)` — because
a volatile position drifts on noise that mostly reverses, and paying fees to
undo noise is just paying. Measured over the year, annualized volatility was
BTC 43%, ETH 60%, SUI 86%, TAO 100%, WLD 121%; on a fixed band the loud names
would breach constantly and the quiet ones never, so you would be told which
asset is jumpiest rather than what has drifted. On a volatile portfolio the
scaling cuts interruptions about 30% for roughly a sixth of a point of tracking.

It is deterministic on purpose. The model still never picks a threshold.

The first version of this ladder was set from equity-market convention — 5%
bands, annual rebalancing — and measured out at 1-6 corrections a year with the
portfolio sitting 4.16pp from target. That is a rebalancing tool that barely
rebalances. Frequent correction turns out to be *cheap* here, because only the
deviation is traded: even the busiest rung is under 1% of NAV a year, and it
cuts average drift by 30x.

The binding constraint is not money but attention — every correction needs a
human approval in Binance, and an unapproved proposal tracks nothing. So the
timing decision is told how many times the owner has already been asked today,
and holds out for the moment worth a signature. A violent day can end in one
message and no proposals.

The two messages below are 37 hours apart *in the same breach*. The drift barely
moved; the answer did:

```
Holding steady on AVAX                          Rebalancing your portfolio now
                                     …vs…
HOLD · falling_knife                            REBALANCE · drift_magnitude
```

Both are verbatim output from `npm run watch:preview`, which renders a real
alert from real data and sends nothing. The bot can only send messages — it
cannot place, cancel or approve an order.

Full behaviour, thresholds, measured frequency and setup:
**[`docs/telegram-alerts.md`](docs/telegram-alerts.md)**.

---

## How the numbers are computed

| Quantity | Definition |
|---|---|
| NAV | `Σ (qty × price)` over spot balances; cash at 1.0 |
| Drift | `(currentWeight − targetWeight) × 100`, in percentage points |
| **Total drift** | `Σ\|driftPp\| / 2` — halved because over- and under-weights always mirror each other, so the result is the share of the portfolio that must change hands |
| Band | `min(cap, max(floor, relative × targetWeight × 100)) × volScale`, set by the tracking preference — balanced is 0.7pp / 6% / 1.5pp. Rungs are the measured rows of `npm run bands` |
| `volScale` | `clamp((realizedVol / 60%)^(2/3), 0.6, 2.5)`, from 14 days of hourly closes — a volatile asset gets a wider band because its drift mostly reverses |
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

## Sixty-one decision points, and what measuring them actually found

One captured HOLD is an anecdote. `npm run decisions` walks a captured window,
runs the full loop wherever something is outside a band, and applies the fills,
so each decision changes what the next one sees. Four runs are committed.

**The first finding was not the one this README expected.**

| Run | Decisions | HOLD | Legs offered | Legs declined |
|---|---|---|---|---|
| [majors, daily](docs/decision-log.json) | 13 | 0 | 17 | 1 |
| [majors, fortnightly, a full year](docs/decision-log-fortnightly.json) | 18 | 0 | 27 | 0 |
| [volatile mix, daily](docs/decision-log-volatile.json) | 9 | 0 | 12 | 0 |
| [majors, daily, **never rebalanced**](docs/decision-log-untouched.json) | 21 | 0 | 46 | 2 |
| **total** | **61** | **0** | **102** | **3** |

**Zero full HOLDs across sixty-one decision points.** Not one. The product was
built around "it can decide to do nothing", and measuring it says that almost
never happens.

The reason is structural rather than disappointing. If you act on the agent's
advice, drift never accumulates — every breach it corrects is a breach that
never grows into the situation where waiting matters. Left alone, the same
window declines **2 of 46 legs (4.3%)** against **1 of 56 (1.8%)** when
followed: judgment is about two and a half times more likely to change the
answer once drift has been allowed to build. Both numbers are small, and three
rejections is a demonstrated capability, not a rate anyone should extrapolate.

### So the claim is narrower than it was, and more specific

Not "sometimes it does nothing". That is vague and, measured, mostly false.

**It gives different answers to different legs of the same check.** A threshold
rule fires everything outside the band. On 2025-10-11 two positions were outside
the same band and got opposite answers:

```json
{ "date": "2025-10-11", "verdict": "PARTIAL", "primaryFactor": "falling_knife",
  "outsideBand": ["AVAX", "BTC"], "acceptedLegs": 1,
  "rejectedLegs": [{ "side": "BUY", "symbol": "AVAX", "notionalUsd": 3626.60 }],
  "reason": "AVAX is dropping sharply and the move is still running, so buying it now
             would be catching a falling knife." }
```

Note what the rejected leg *is*: a **buy** of the asset that had fallen. The
product's own pitch is that buying your losers is psychologically hard — and the
agent's refinement is that it is also wrong while they are still falling. It
bought BTC and left AVAX alone.

Reproduce it: `npm run decisions -- --data data/demo-window.json --from 30 --every 24 --case 2025-10-11`

That replays the *path* to the date, not the bar. Jumping straight to 2025-10-11
returns REBALANCE with nothing declined, because by then the walk has rebalanced
several times and the portfolio is not the one that was bought. A decision is a
function of how you got there.

It has now reproduced on three independent runs — same date, same factor, same
asset. What it cannot promise is the verdict on a marginal call: Gemini's free
tier does not repeat itself even at temperature 0. Every *figure* is identical
every time, because the model is not allowed to produce one.

### Where the single captured HOLD fits

[`hold-example.json`](docs/hold-example.json) is real and stays. It is the same
judgment in its extreme form, and the context matters: that portfolio was bought
once and **left alone for weeks**, so drift reached 4.9pp with AVAX still
climbing hard and *every* breached position was mid-move. Nothing was worth
sending, so nothing was.

On a portfolio checked daily and corrected each time, that situation does not
arise — the same judgment shows up as a declined leg instead. Two regimes, one
mechanism.

None of this was arranged. Loosening the bands would produce more HOLDs and a
worse agent, which is the kind of thing that reads as tuned for a demo.

---

## Does the judgment actually beat the threshold?

Everything above asserts that deciding *when* to rebalance beats rebalancing
whenever a band is crossed. `npm run backtest` measures it: three strategies,
identical data, identical check points, identical cost model.

```bash
npm run backtest -- --no-llm                                    # hold vs threshold, instant
npm run backtest -- --every 168 --band-floor 1.0 --band-rel 0.12  # all three
```

One real year of BTC/ETH/SOL/AVAX (2025-09 → 2026-09), $100k start, weekly
checks, a tight mandate (bands of max(1.0pp, 12% of target)) — because wide
bands only trigger a handful of times a year and leave judgment almost nothing
to decide:

| | avg \|drift\| | cost paid | trades | final NAV |
|---|---|---|---|---|
| hold (never rebalance) | 10.46pp | $0.00 | 0 | $61,311 |
| threshold bot | 2.88pp | $27.74 | 11 | $60,230 |
| **agent** | **2.90pp** | **$21.57** | **10** | $60,070 |

**Same tracking, 22% less cost.** The agent held the portfolio just as close to
target (2.90pp vs 2.88pp — a rounding difference) while paying $6.17 less to do
it. It declined twice where the bot traded, and judgment ran at all 10 decision
points with zero fallbacks, so this is the model's record and not the band
rule's wearing its name.

Read that scorecard in order. Rebalancing is not a return-maximising strategy,
so "which made more money" over one window is mostly the market: the $161 NAV
gap is 0.27%, noise. What rebalancing is *for* is holding a portfolio near its
target at an acceptable cost, which is why tracking and cost come first.

Two things worth saying plainly:

- **The honest result is "cheaper for the same tracking", not "more money".**
  Anyone claiming a rebalancing agent beats the market over one year is reading
  luck.
- **The threshold bot lost to doing nothing** ($60,230 vs $61,311). In a falling
  market, disciplined rebalancing into the fall costs money — which is the real
  argument for a strategy that can decline, and also a warning against reading
  any single window as proof.

Full output in `docs/backtest.json`.

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
