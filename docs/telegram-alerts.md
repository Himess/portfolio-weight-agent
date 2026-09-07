# Standing alerts

The app can only tell you something when you open it. Drift happens while you
are not looking, and the moment worth acting on has usually passed by the time
you think to check. This is the part that closes that gap.

It is deliberately not a price alert. It fires on the same band the app draws on
screen, and it carries the agent's verdict — including the verdict to wait,
which is the one a threshold bot can never send.

---

## What triggers it

Nothing new. A watch uses the identical rule the app uses, and the *owner* sets
it with the "How closely to track" control:

```
band_i = min(cap, max(floor, relativeBandPct x targetWeight_i x 100))
```

| Preference | floor | relative | cap | band on a 40% position |
| --- | --- | --- | --- | --- |
| patient    | 1.0pp | 15%  | 2.5pp  | ±2.50pp |
| balanced   | 0.7pp | 6%   | 1.5pp  | ±1.50pp |
| tight      | 0.4pp | 3%   | 0.75pp | ±0.75pp |
| continuous | 0.2pp | 1.5% | 0.4pp  | ±0.40pp |

Inventing a *second*, quieter threshold for notifications would mean the alert
and the app disagreed about whether anything was wrong, and the owner would
learn to distrust both. So there is one line, the owner draws it, and the agent
decides what to do when it is crossed — including deciding to wait.

### The band is not a constant

A fixed percentage-point band is wrong for a portfolio that holds both BTC and
WLD. Measured over the year from 2025-09-06, annualized hourly-return volatility
was BTC 43%, ETH 60%, SOL 67%, AVAX 74%, SUI 86%, TAO 100%, WLD 121%. On a fixed
band the volatile names breach constantly and the calm ones never do — you are
not being told about drift, you are being told which of your assets is jumpiest.

So the band scales with each asset's own realized volatility, measured from its
last two weeks of hourly closes:

```
band_i = min(cap, max(floor, relative x weight_i x 100)) x volScale_i
volScale_i = clamp( (vol_i / 60%) ^ (2/3), 0.6, 2.5 )
```

The reasoning is not cosmetic. A volatile asset drifts further for no reason,
and much of that drift reverses on its own — correcting it immediately means
paying fees and spread to undo noise. The optimal no-trade band grows roughly
with volatility^(2/3), which is the exponent used. The cube root matters: a
doubling of volatility must not double the band.

This is deliberately **deterministic**. The model still never picks a threshold;
it only decides what to do once one is crossed. That boundary is the product.

Measured effect on a volatile portfolio (BTC 30 / ETH 15 / SUI 15 / TAO 15 /
WLD 15 / USDT 10, a year of hourly bars):

| | fixed band | volatility-scaled |
|---|---|---|
| continuous | 2190/yr, 0.80%, 0.38pp | **1622/yr, 0.68%, 0.41pp** |
| tight | 863/yr, 0.49%, 0.67pp | **620/yr, 0.43%, 0.70pp** |
| balanced | 295/yr, 0.30%, 1.25pp | **204/yr, 0.24%, 1.41pp** |

About 30% fewer interruptions and lower cost, for a tracking difference of
roughly a sixth of a percentage point. That is the trade the scaling buys.

### The measurement that set the rungs

`npm run bands` sweeps band widths over a year of real hourly closes, checking
**every hour**, and applies real costs to every fill: the 10bps taker fee,
slippage walked through the order book, and exchange step/tick/minNotional
filters. Same `generateCandidates` the product uses. Add `--fixed-bands` to see
the unscaled comparison, `--data data/window-volatile.json` for the volatile mix.

Majors (BTC 30 / ETH 15 / SOL 15 / AVAX 15 / USDT 10), as shipped:

```
band       base     rebal/yr   cost/yr   mean drift   final NAV   vs never
never      —        0          0.00%     10.76pp      $59,930     +0.00%
continuous ±0.40pp  750        0.28%     0.33pp       $58,861     -1.78%
tight      ±0.75pp  246        0.15%     0.61pp       $59,141     -1.32%
balanced   ±1.50pp   76        0.08%     1.18pp       $59,424     -0.84%
patient    ±2.50pp   19        0.04%     2.22pp       $59,082     -1.41%
```

A volatile portfolio runs roughly 2-3x those rates.

Three things come out of it.

**Frequent rebalancing is cheap here.** Even the busiest rung costs well under
1% of NAV a year, because only the *deviation* is traded, never the portfolio.
The equity-market intuition that frequent rebalancing is expensive does not
transfer to a tool that trades a few hundred dollars at a time.

**The tracking difference is enormous.** Average drift goes from 10.76pp
(untouched) to 0.33pp. That is what rebalancing is *for*.

**The NAV column is noise, and is printed to show that it is.** The ordering is
not monotonic, and on the volatile window every setting *beat* never-rebalancing
while on the majors window every setting lost to it. That is the direction the
market happened to go, not skill. Anyone reading a rebalancing tool's backtest
as a return claim is reading it wrong.

### The agent spends your attention, and knows it

Correcting drift costs cents. Being asked costs a person. Every proposal needs a
hand-made approval in Binance, an unapproved proposal tracks nothing, and
somebody asked six times a day stops reading — so attention is the scarce
resource, and the timing decision is told how much of it has already been spent
today (`askedLast24h`).

That is the LLM *selecting*, not computing: the threshold stays arithmetic, and
the model decides which breach is worth a signature. A violent day can
legitimately end in one message and no proposals.

Observed, on bar 4740 of the volatile window — a marginal breach, two assets
barely out, $0.69 to fix:

```
askedLast24h: 0   PARTIAL · drift_magnitude   acts on TAO and WLD
askedLast24h: 8   PARTIAL · falling_knife     drops TAO, acts on WLD alone
```

Stated precisely: the budget narrowed the ask rather than flipping it to HOLD.
That is one A/B pair at temperature, not a controlled result, and it is not
evidence that the budget reliably changes a verdict — only that the model reasons
with it.

### The real limit is not money

It is attention. Every correction needs a human approval in Binance, and nobody
approves 822 things a year. That is why the ladder spans the curve and the app
prints what each rung costs in interruptions next to it — `continuous` is
offered, and honestly labelled as a few decisions a day, because an unapproved
proposal tracks nothing.

Concentration matters as much as the setting: a 50% position needs an enormous
relative move to breach even ±1.5pp, while a 15% satellite breaches on an
ordinary week.

---

## What arrives

Verbatim output from `npm run watch:preview` and `npm run hold:example`, both of
which run the real agent loop over the committed replay window and render the
message without sending anything. Nothing is mocked up, and the bands shown are
the volatility-scaled ones the product actually applies.

Same breach, 37 hours apart, on the shipped `balanced` setting. The drift barely
moved; the answer did.

### While the move is still running — bar 393, 23 Sep 2025

```
Holding steady on AVAX

AVAX is still running hot with high volatility, so we are holding off on
rebalancing today despite the 4.9pp drift. Letting momentum cool protects us
from chasing the price while it surges. We will wait for the market to settle
before trimming the position.

Outside its band
• AVAX 19.9% against a 15.0% target — +4.9pp over, band ±1.2pp
• BTC 37.8% against a 40.0% target — −2.2pp under, band ±0.9pp
• ETH 18.2% against a 20.0% target — −1.8pp under, band ±0.9pp

$107,119 · 4.9pp total drift · balanced tracking

Nothing to approve. You will hear from the agent when that changes.
```

`HOLD · falling_knife` — full input and output in
[`hold-example.json`](hold-example.json). AVAX is +4.86pp against a 1.23pp band,
so a threshold rule trades here; `volRatio` 1.93 with 4h +3.2% and 24h +9.9% is
why the agent did not.

### After it settles — bar 430, 24 Sep 2025

```
Portfolio rebalanced after 17 days

We trimmed AVAX after its strong run and used the proceeds to buy ETH and BTC.
This disciplined sale of winners and purchase of laggards reduces your total
drift by 4.1pp.

Outside its band
• AVAX 19.7% against a 15.0% target — +4.7pp over, band ±1.2pp
• ETH 18.1% against a 20.0% target — −1.9pp under, band ±0.9pp
• BTC 38.3% against a 40.0% target — −1.7pp under, band ±0.9pp

$107,130 · 4.7pp total drift · balanced tracking

Nothing has been ordered. Open the app to review and approve.
```

`REBALANCE · drift_magnitude`

### The judgment is not reproducible; the arithmetic is

Worth stating plainly, because it is the boundary the whole product rests on.

Re-running bar 393 on identical input gave `HOLD` once and `PARTIAL` on later
runs — the PARTIAL declining AVAX exactly as the HOLD did, but also buying the
two underweights while waiting. The decision calls run at temperature 0 and
Gemini's free tier still does not repeat itself.

(A `seed` parameter was tried and removed within the hour: Gemini rejects the
field outright with `Unknown name "seed"`, so every decision call 400'd and fell
back to the deterministic default — a silent downgrade of the judgment layer in
exchange for a parameter the provider does not implement.)

What *is* repeatable is every number: NAV, drift, each band, the slippage walk,
the cost. Those come from `src/core/`, are pure, and are covered by 159 tests.
That is exactly why the model is not allowed to compute them — and why the
verdict is always shown next to the figures that produced it.

### The all-clear

Sent once, when a portfolio comes back inside its bands — so an alert you are
still holding open gets closed. Deterministic; no model call is needed to say a
number came back into range.

Real output, bar 436 (24 Sep 2025, 22:00Z) — the hour after the 49-hour AVAX
episode above closed:

```
Back inside its bands

Everything in BTC / ETH / L1s / USDT is within tolerance again. Total drift is
3.7pp on $105,398.

Nothing to do. You will not hear from the agent again until something moves out
of band.
```

3.7pp of total drift with nothing outside a band is not a contradiction: total
drift is the sum of every position's deviation, and it can sit well above zero
while each individual position is still within its own tolerance.

### When the judgment layer is down

The message says so, rather than passing off the deterministic default as a
considered call:

> _The judgment layer was unavailable, so this is the deterministic default
> rather than a considered call._

---

## When it stays quiet

A portfolio parked outside its band is outside it every hour, and an alert per
hour is an alert nobody reads. `src/lib/watch.ts` decides, and it is pure and
tested:

| Situation | Message? |
| --- | --- |
| Nothing outside a band, and nothing was | no |
| A band is crossed for the first time | **yes** |
| Same verdict, same assets, inside the repeat window | no |
| Same verdict, same assets, repeat window elapsed (default 24h) | **yes** |
| Verdict changed (e.g. HOLD → REBALANCE) | **yes, immediately** |
| A different asset joins the breach | **yes, immediately** |
| Back inside every band after a breach | **yes, once** |
| Paused, or no chat linked | no |

A brand-new watch that is already inside its bands says nothing at all. The
all-clear is only meaningful as the answer to an alert you are still holding.

---

## Cost

Drift is arithmetic on live prices, so it is computed for every watch on every
scan and costs nothing. The judgment call costs one LLM request, and only runs
for a portfolio that has actually crossed a band — on the measured data, 5% of
scans. `MAX_JUDGMENTS_PER_RUN` caps it at 5 per scan so one volatile morning
cannot spend a day's free-tier quota; deferred watches are picked up next run.

---

## What the bot can and cannot do

It can send you messages. That is all it can do.

It cannot place, cancel or approve an order. There is no withdrawal scope in the
Binance MCP server, and the bot does not touch MCP at all — it reads public
prices and the allocation you registered. The strongest thing a Telegram chat
can do is unsubscribe itself.

Chat commands: `/status`, `/check`, `/pause`, `/resume`, `/stop`.

Message text from a chat is parsed as that fixed set of commands and never
reaches the model.

---

## Setup

Three environment variables, then one URL.

### 1. Create the bot

In Telegram, message [@BotFather](https://t.me/BotFather) → `/newbot` → pick a
name and a username. It replies with a token like `8123456789:AAF…`.

### 2. Set the variables

| Variable | What it is |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | the token BotFather gave you |
| `CRON_SECRET` | any long random string; guards the scan and the setup route |
| `AUTH_SECRET` | already required in production; the webhook secret is derived from it |
| `APP_URL` | optional — set it if you use a custom domain |

On Vercel: Project → Settings → Environment Variables, then redeploy.

Never paste the bot token into a shell command or a chat. A leaked bot token
lets anyone post as your bot to every chat that ever started it.

### 3. Point Telegram at the deployment

Open this once in a browser:

```
https://<your-app>/api/telegram/setup?key=<CRON_SECRET>&register=1
```

Drop `&register=1` to just read the current state — which bot, which webhook,
whether the cron secret is set, and which watch store is in use.

### 4. Schedule the scan

`vercel.json` registers `/api/cron/watch` daily at 09:00 UTC. Hourly is the
intended cadence, but Vercel's Hobby plan **rejects the deployment outright** for
any sub-daily expression:

> Hobby accounts are limited to daily cron jobs. This cron expression
> (`0 * * * *`) would run more than once per day.

So daily is what ships. For true hourly checks, either change the schedule to
`0 * * * *` on a Pro plan, or point any external scheduler — cron-job.org, a
GitHub Action, a phone shortcut — at:

```
https://<your-app>/api/cron/watch
Authorization: Bearer <CRON_SECRET>
```

Schedulers that can only take a URL may use `?key=<CRON_SECRET>` instead. That
is second-best: a secret in a query string ends up in access logs.

The endpoint refuses every request when `CRON_SECRET` is unset — an open scan
endpoint would let anyone drain the deployment's LLM quota in a loop.

---

## Durability

A watch has to outlive the request that created it, and there is no database.
`src/server/watch-store.ts` picks a backend from what the environment offers and
`describeStore()` reports which one, so the durability story is never implied:

| Backend | When | Survives a cold start |
| --- | --- | --- |
| `redis` | `KV_REST_API_URL` + `KV_REST_API_TOKEN` are set (the names Vercel's Upstash integration provisions) | yes |
| `file` | not running on Vercel — `data/watches.json` | yes, locally |
| `memory` | anything else | **no** |

On Vercel without Upstash, watches are held in memory and are lost on the next
cold start. That is reported as a warning, not as normal.
