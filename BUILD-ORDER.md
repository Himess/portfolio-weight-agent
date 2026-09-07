# Build order — Portfolio Weight Agent

Read this whole file before starting. The work is ordered by priority and the
order matters: P0 breaks the demo, P1 changes what the submission *is*, P2 makes
the thesis provable, P3 is polish. If time runs short, cut from the bottom.

**Target:** first place, Binance Agent OS Mini Hackathon Track A.

---

## The strategic change, stated first

The submission is no longer "a web app that simulates having a Binance account."
It becomes **an MCP server that runs beside Binance's own MCP server inside
Claude Code**, with the web app as a second surface onto the same engine.

Why this is the right move, so you don't second-guess it mid-build:

The single biggest weakness right now is that the app cannot connect to a real
Binance account — Binance's OAuth needs a hand-issued `client_id` and there is no
self-service route. Inside Claude Code that problem disappears, because Claude
Code is already a registered client. Real balances, real prices, real orders,
real Binance confirmation dialog. The simulation ends.

It is also what the platform asks for. Binance's own hackathon post says to
combine their primitives rather than pick one, and every example they highlight
of what people are building is a personal setup inside an AI client, not a public
web product. Track A rewards the best *agent*, not the most users.

**Do not delete or deprioritise the web app.** It stays, it shares the same core,
and it appears in the demo video as the visual surface of the same agent.

---

## P0 — Fix the broken demo path

The replay dataset and the default allocation do not match, and it produces a
visibly wrong result on the deployed site right now.

The dataset is `BTC, ETH, SUI, TAO, WLD`. The default allocation is
`BTC, ETH, SOL, AVAX, USDT`. So SOL and AVAX price as `$0.0000`, sit at `0.0%`
weight, and roughly half of the headline `30.0pp` drift is an artifact of two
assets having no price data at all.

Worse, it produces a self-contradiction on the Proposal screen: the narrative
says *"Selling what went up allows us to buy SOL and AVAX"* while THE PLAN
contains two SELL legs and no buys.

Fix all three:

1. Make the default allocation and the shipped dataset the same symbol set.
   Pick one and regenerate the other.
2. **Any symbol with no price in the active data source must be refused at
   allocation time, not silently priced at zero.** A missing price is an error
   state, not a $0 holding. Surface it in the UI.
3. Add a test that fails if the narrative claims a side (`buy`/`sell`) that does
   not appear in the materialised plan. That contradiction should never be able
   to ship again.

---

## P1 — The MCP server

Build `src/mcp/` exposing the existing engine as MCP tools. This is a thin shell
over `src/core/` and `src/llm/` — it is not a rewrite. Do not duplicate logic;
import it.

### Architecture — read carefully, this is the crux

Your server **cannot call Binance's MCP server.** Claude Code is the orchestrator
and holds both connections. So:

- **Holdings and account data** arrive as tool *inputs*. Claude reads them from
  the Binance MCP server and passes them to you.
- **Market data** you fetch yourself, directly, via the existing
  `PublicAdapter` — Binance's public market endpoints need no auth. Do not ask
  Claude to relay prices; it will paraphrase them and the numbers must be exact.
- **Orders** you never place. You return a materialised plan; Claude sends it
  through the Binance MCP server; Binance shows its confirmation dialog to the
  user.

### Transport

Stdio first — a local Node entrypoint Claude Code can launch. It has no deploy
risk and it works today. If it lands early, additionally expose the same server
over Streamable HTTP at `/api/mcp` on the Vercel deployment so a judge can add it
without cloning. Stdio is the one that must work.

Use `@modelcontextprotocol/sdk`.

### Tools

Every tool returns strict JSON. Every figure comes from `src/core/`. The
"model selects and explains, never computes" rule applies here exactly as it does
in the web app — and here it matters more, because the calling model is Claude
Code, which is not sandboxed by your prompts.

```
set_allocation(targets, tracking?)
  targets: [{ symbol|category, weight }]  — weights must sum to 1.0
  Validates against the live tradable universe. Resolves any category to
  symbols via the existing basket resolver, returns the resolution WITH its
  rationale and exclusions for the user to approve. Persists via the existing
  watch-store. Rejects unknown or untradable symbols rather than dropping them
  silently.

review_portfolio(holdings)
  holdings: [{ symbol, qty }]  — passed in from the Binance MCP account read
  Returns: NAV, per-position target/current/drift/band/outsideBand, total drift,
  and the same missing-price error state as P0. No judgment, no LLM. Pure math.

propose_rebalance(holdings, context?)
  Runs the full loop: drift → candidates → cost/benefit → timing → execution →
  narrative. Returns verdict (REBALANCE | PARTIAL | HOLD), the reasoning, the
  fact sheet the judgment was made from, and — when acting — the ordered,
  materialised legs with exact quantities, order type, and estimated cost.
  On HOLD, ALSO return the trade it declined to make, sized and priced.
  That rejected trade is the product's whole thesis; it must be in the payload,
  not just in prose.

explain_decision(question?)
  Answers from the last proposal's stored fact sheet, not from a fresh guess.
  "Why didn't you sell AVAX?" must be answerable with the actual numbers that
  drove the verdict. This is currently thin in the chat surface — fix it here
  and reuse it there.

list_decisions(limit?)
  The decision history from P2 below.
```

### Ship with it

- `mcp.json` / config snippet showing how to add both servers side by side.
- A README section with the exact Claude Code setup, and the transcript of one
  real session end to end.

---

## P2 — Make the thesis provable

### Decision history

Right now a single HOLD lives in `docs/hold-example.json`. Replace that with a
persisted log: every check, its verdict, its primary factor, the drift at the
time, and a one-line reason. Expose it via `list_decisions` and as a panel in
the web app.

```
12 Mar  HOLD       move still running
19 Mar  HOLD       cost exceeds the drift it removes
25 Mar  REBALANCE  volatility normalised · 13.0pp corrected
```

A sequence like that proves "it can wait" far better than one screenshot does.
Generate a real one from the replay year and commit it.

### Telegram

The layer is written and tested but has never sent a message. Get a token from
BotFather, set the variables, register the webhook, send one real alert, and
capture it. "Built but never ran" is not a sentence to put in front of judges.

### First entry — the case the product currently ignores

Someone holding 100% USDT who sets 50/30/20 has ~80pp of drift. A threshold bot
buys everything at once. The agent should not: committing an entire portfolio at
one moment is pure timing risk.

The machinery already exists — `PARTIAL` is in the schema and the
"move still in progress" signal is computed. What is missing:

- a flag in the fact sheet marking this as an initial entry rather than a
  correction (detect it: cash weight far above target, most positions at zero)
- a laddering rule in the timing prompt for that case
- copy in the UI that names it, because this is the first thing a new user hits
  and the product currently assumes an existing portfolio

### Limit orders

The execution schema already supports limit orders and a mid-price offset, and
nothing uses it. Turn it on. On a thin book a resting limit order saves real
money, and a plan that reads `limit @ mid` instead of `market` shows the agent is
reasoning about execution, not just about size. Keep market orders where the book
is deep enough that the spread costs more than the fill risk — and make that
choice the model's, from precomputed depth figures.

---

## P3 — Interface and copy

- **Live market data becomes the default source.** Replay is a demo tool, not a
  product feature; move it into a clearly-labelled demo mode along with the two
  date sliders. It should not sit first in the list looking like the normal way
  to use the app.
- **Retitle "How closely to track".** It is not a frequency setting — "~76 a
  year" is a measured average from historical data, not a schedule. Retitle it to
  ask how much drift the user will tolerate, and state plainly that **bands scale
  per asset with realised volatility** (BTC's band is tighter than SUI's). That
  behaviour already exists and the UI never mentions it. It is a selling point.
- **Explain `pp` once, inline.** Percentage points. `±1.5pp` on a 40% target
  means the agent looks when the position leaves 38.5–41.5%.
- **Add a tokenised US equities category chip** alongside Layer 1 / DeFi / AI.
  The preset already exists. It shows the judges you know their own products.
- **Split the Allocate screen.** It currently shows the chat box, presets,
  weights, token search, categories, the Binance panel, four tolerance options,
  the data source and two time sliders all at once. Nobody parses that. First
  screen answers one question: *what weights do you want?* Everything else goes
  into a collapsed settings section or moves to a later screen.

---

## Do not do these

- **No API-key field in the UI.** Binance's MCP server is OAuth-only; there is no
  API-key path into Agent OS. Asking users to paste exchange API keys into an
  unaudited hackathon app is the thing a Binance judge will react worst to. The
  existing "I have an access token" field for developers with an existing session
  stays exactly as it is.
- **No MA, RSI, or trend-break signals.** The agent's question is "is now a good
  moment to correct a known drift", not "will the market go up". Adding direction
  prediction changes the product into a forecaster, and the "I can wait" thesis
  collapses because waiting becomes a prediction. Signals that are *not*
  directional are welcome: current volume versus typical, whether the whole
  market moved together, how unusual this move is in context.
- **No bypassing the confirmation gate**, in either surface.

---

## Submission

- Follow `@Binance`, repost the announcement, reply or quote-repost with the
  video and the GitHub link, complete the survey. Before **2026-09-08 23:59 UTC**.
- **The video leads with the Claude Code session**, not the web app: two MCP
  servers connected, a real portfolio read, a HOLD with its reason, then a
  REBALANCE, then Binance's own confirmation dialog appearing and the order
  filling. Cut to the web app afterwards — same agent, visual surface.
  The moment the Binance dialog appears on screen is the only unfakeable thing
  in the whole submission. Give it room.
- README must state plainly what the agent decides versus what is structurally
  computed, that no order is ever placed by the app, that there is no withdrawal
  scope in the Binance MCP server, and that this is not investment advice.
- Keep `docs/mcp-tools.json` honest — if the live `tools/list` is captured with a
  real session, commit it; Binance does not publish those names anywhere.
