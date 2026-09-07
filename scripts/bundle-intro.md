# Portfolio Weight Agent — read this first

You are being asked to review a hackathon submission and say how to make it
better. The code follows in the other files in this bundle. Please read this
one first: most of what is worth arguing about is a judgement call, not a
lint finding, and you cannot see the judgement calls from the source alone.

**Live:** https://portfolio-weight-agent.vercel.app
**Source:** https://github.com/Himess/portfolio-weight-agent
**Context:** Binance Agent OS Mini Hackathon, Track A. Deadline 8 Sept 2026.

---

## What it is

> Selling your winners and buying your losers is psychologically hard.
> The agent proposes it; you approve it.

A portfolio rebalancing agent for Binance spot. You declare target weights once.
The agent watches drift, decides *whether now is a good moment*, and proposes
trades you approve inside Binance. It never places an order.

The thing it is trying to be is not a rebalancing bot. A bot fires whenever a
threshold is crossed. This is supposed to be able to say **"you have drifted,
and I am not going to act on it yet, and here is why"** — and to be right about
that often enough to be worth trusting.

## The one rule everything else follows

**The model selects and explains. It never computes.**

Every number a user sees — NAV, drift, band widths, slippage, cost, quantities
— comes from pure functions in `src/core/`. The model is handed a precomputed
fact sheet and picks among precomputed options. This is enforced, not merely
intended:

- The narrative layer makes the model write `{{TOKEN}}` placeholders and
  substitutes real figures afterwards. Before substituting, the raw output is
  scanned for any bare money/percentage/pp/bps figure the model typed itself;
  if it typed one, the whole response is discarded for a deterministic template.
- The command layer applies the same rule, with one carve-out: a figure that
  appears verbatim in the user's own instruction is allowed through, because
  echoing someone's number back is not fabricating one.
- Symbols the model names are checked against the live tradable universe and
  dropped if absent. Models are confident about tickers that never existed.
- Basket weights are normalised only if already within tolerance of 1.0; a
  wildly wrong set is rejected rather than silently rescaled.

If you want to propose moving something across that line in either direction,
that is exactly the kind of feedback wanted — but please argue it explicitly.

## Architecture

```
src/core/       pure math. drift, bands, candidate trades, slippage, signals,
                cost/benefit, commands. no I/O, no model, fully tested.
src/llm/        the four places a model is consulted: timing, execution,
                basket resolution, narrative — plus command routing.
                provider.ts is the only file that names a vendor.
src/adapters/   Binance public market data, a replay adapter for captured
                windows, and an MCP client for the user's account.
src/server/     sealed sessions, rate limiting, the Telegram watch store.
src/app/        Next.js App Router. four screens + a chat surface + API routes.
scripts/        every measurement quoted anywhere is produced by one of these.
```

The loop, in `src/agent.ts`:

```
drift → candidates → cost/benefit → [TIMING] → re-derive if PARTIAL
      → [EXECUTION] → materialize from deterministic qty → [NARRATIVE]
```

## What has already been measured

Please do not suggest measuring these; suggest what they should change.

**Band widths.** `npm run bands` sweeps band widths over a year of real hourly
closes, checking every hour, applying the 10bps taker fee, order-book slippage
and exchange filters to every fill. On a majors portfolio:

| setting | base band | corrections/yr | cost/yr | mean drift |
|---|---|---|---|---|
| never | — | 0 | 0.00% | 10.76pp |
| patient | ±2.50pp | 19 | 0.04% | 2.22pp |
| balanced | ±1.50pp | 76 | 0.08% | 1.18pp |
| tight | ±0.75pp | 246 | 0.15% | 0.61pp |
| continuous | ±0.40pp | 750 | 0.28% | 0.33pp |

The defaults were originally set from equity-market convention (5% bands,
annual rebalancing) and measured out at 1–6 corrections a year with the
portfolio 4.16pp from target on average — a rebalancing tool that barely
rebalances. Frequent correction turns out to be cheap here because only the
*deviation* is traded, never the portfolio.

**Volatility scaling.** Bands scale per asset:
`clamp((realizedVol / 60%)^(2/3), 0.6, 2.5)` from 14 days of hourly closes.
Measured annualized vol over the year: BTC 43%, ETH 60%, SOL 67%, SUI 86%,
TAO 100%, WLD 121%. On a volatile portfolio the scaling cuts interruptions
~30% for ~0.15pp of tracking.

**HOLD vs a threshold bot.** `docs/backtest.json` — over 52 weekly checks, the
agent held the same tracking quality for 22% less cost. But the threshold bot
*lost to doing nothing* ($60,230 vs $61,311), because in a falling market
disciplined rebalancing buys into the fall. That is reported as-is.

**A captured HOLD.** `docs/hold-example.json` — bar 393, AVAX +4.86pp against a
1.23pp band, volRatio 1.93, 4h +3.2%, 24h +9.9%. A threshold rule trades here;
the agent declined and said why.

**Schema-pass rate.** 40/40 on the judgment calls at the time it was measured.

## What is honestly weak — the useful things to attack

1. **Binance MCP is not actually connected.** OAuth is authorization_code +
   PKCE with no dynamic client registration, so an app needs a client_id
   Binance issues by hand. This one has none, and borrowing another product's
   would show the user *that product's name* on the consent screen. The panel
   says so plainly. Live prices work either way; only reading real balances
   does not. Is there a better answer than the one taken?

2. **B402 / the Bazaar are researched but unused.** `binance-agent-os-inventory.md`
   documents why: becoming a merchant needs a human-approved form and an IP
   whitelist, Bazaar listing requires a settled payment first, Agentic Wallet
   dies at 48h and caps x402 at ~$20/day, and `baw x402-payment` is v2-only so
   it cannot pay ~96% of live Bazaar endpoints. Judged too expensive for the
   time left. Is that the right call for a hackathon on this platform?

3. **The attention budget only half works.** The timing prompt is told how many
   times the owner has been asked today, with a per-preference budget and its
   own `attention` primary-factor label. On gemini-flash-lite it does not
   change the verdict — measured, A/B, at 0 and 12 asks. So the real limit was
   moved to the notifier, where it is deterministic and tested. The prompt-side
   version is documented as not working rather than claimed.

4. **The judgment layer is not reproducible.** Decision calls run at
   temperature 0 and Gemini's free tier still gives HOLD once and PARTIAL on
   re-runs of identical input. A `seed` parameter was tried and reverted within
   the hour — Gemini rejects the field and every call 400'd into the fallback.
   Every *number* is reproducible; the verdict on a marginal bar is not.

5. **Telegram alerts have never sent a real message.** The whole layer is built
   and tested — band trigger, quiet windows, escalation, budget, webhook auth,
   store durability — but no bot token exists yet, so it is unproven end to end.

6. **No demo video, no screenshots.** `docs/screenshots/` is empty.

7. **The `explain` intent in the chat is thin.** It routes, but answers from
   the router's one-line acknowledgement rather than from the last proposal's
   fact sheet. "Why didn't you sell AVAX?" deserves a real answer.

8. **Watch storage is memory-only on the deployed instance.** Upstash is
   supported and unconfigured, so a cold start forgets every subscription.
   `describeStore()` reports this as a warning rather than hiding it.

## Constraints that are not negotiable

- The app must never place, cancel or approve an order. Approval happens in
  Binance, in front of the person. There is no withdrawal scope in the Binance
  MCP server at all.
- No invented figures reach the user. See the rule above.
- It must keep working with no API key — the deterministic path and a labelled
  fallback are always available.
- Free tier only. The judgment provider is Gemini's free tier; anything that
  assumes a paid model is not usable here.

## What would actually help

Ranked roughly by what is wanted most:

1. **Is the product thesis defensible?** "It can say wait, and a bot cannot" —
   does the evidence in `docs/` actually support that, or is it a nice story
   over a threshold rule with extra steps?
2. **Where is the boundary wrong?** Anything the model does that arithmetic
   should, or vice versa.
3. **What would a Binance judge find missing?** Especially regarding the
   platform's own primitives.
4. **What is over-built?** This has grown a lot in a short time. What should be
   cut to make the rest land harder?
5. **Interface.** Four screens plus a chat panel, hand-rolled from design
   tokens. What reads as confusing or unfinished?
6. **Code quality.** Naming, structure, dead ends, tests that assert the wrong
   thing.

Blunt is better than kind. Things that are wrong are more useful to hear than
things that are fine.

---

## File map

```
{{TREE}}
```
