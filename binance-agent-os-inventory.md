# Binance Agent OS — Build-Decision Inventory

**Compiled:** 2026-09-06 · **Target:** Mini Hackathon Track A, deadline 2026-09-08 23:59 UTC (~36h)

**Sources.** Every claim below is cited. Two kinds of citation appear:

- `[docs: <path>]` — text from Binance's own documentation, pulled via
  `https://developers.binance.com/en/docs/llms-full.txt` (8.0 MB, 802 documents, fetched 2026-09-06).
  Paths map to `https://developers.binance.com/en/docs<path>`.
- `[measured: <date>]` — a live request I made against a production endpoint. Reproduce commands are
  in the appendix. These are observations, not documentation.

Where the docs are silent I write **not documented** rather than inferring.

---

## 0. The one-paragraph answer

The buyer side of B402 is fully buildable today with viem/ethers and **zero Binance credentials** —
I verified the facilitator addresses the docs claim buyers cannot obtain are in fact published in
every live 402 response, and confirmed both addresses on BSC mainnet. The Bazaar discovery API is
live, public, unauthenticated, and returns 979 resources. The seller side is **hard-blocked** behind
a Google Form (clientId + accessToken + RSA key + IP whitelist, issued per-environment) — you cannot
stand up a B402-settled paid endpoint in 36 hours. The Binance MCP server is OAuth-gated with no
headless path and no documented tool list. The Agentic Wallet `baw` CLI **does** ship x402 (the
product doc page that omits it is stale), runs headless for up to 48h after a one-time phone scan,
and its confirm gate is an explicitly waivable prompt-level guardrail, not an API gate.

**Build against: Bazaar (read) + your own viem buyer (write) + `baw` for custody.** Do not build
anything that requires being a B402 merchant.

---

## 1. What's live and callable today

| Capability | Status | Auth needed | Evidence |
|---|---|---|---|
| B402 Bazaar discovery REST | **Live**, 979 resources | **None** | [measured: 2026-09-06] |
| B402 facilitator on BSC mainnet | **Live**, 19,769 txs from signer EOA | n/a | [measured: 2026-09-06] |
| Buyer-side EIP-712 signing (Permit2 + EIP-3009) | **Live** — pure local crypto | **None** | [docs: /products/onchainpay-x402/open-apis-v2/4.permit2-signing] |
| Paying real merchants (Nansen, CoinMarketCap) on BSC | **Live** — 3 hosts advertise BSC | **None** | [measured: 2026-09-06] |
| `baw` CLI incl. `x402-payment` | **Live**, npm `@binance/agentic-wallet@1.9.0` (2026-08-27) | QR scan in Binance app | [measured: 2026-09-06], [repo: skills/binance-web3/binance-agentic-wallet/SKILL.md] |
| Binance MCP server | **Live** but OAuth-gated | Binance login + browser consent | [docs: /agent-native/mcp-server/agentic], [measured: 401] |
| B402 `/verify` + `/settle` (seller) | Live but **credential-gated** | Google Form onboarding | [docs: /products/onchainpay-x402/basics/6.apply-developer-account] |
| Skills Hub repo | **Live**, 19 skills, MIT | None to read | [repo: github.com/binance/binance-skills-hub] |

---

## 2. Answers to your six questions

### Q1 — B402/x402 buyer side

**The critical structural fact: `/papi/v2/b402/*` is not a buyer API.** All three endpoints
(`/supported`, `/verify`, `/settle`) are merchant-facing and require RSA-signed requests with a
registered `clientId`, `accessToken`, and whitelisted IP
[docs: /products/onchainpay-x402/basics/4.base-urls]. The docs are explicit that buyers are locked
out: *"Buyers cannot call `/supported` themselves (it requires merchant credentials)"*
[docs: /products/onchainpay-x402/integration-guideline].

So the buyer's entire interface is: **an HTTP 402 response, and a retry with a signed header.** You
never touch a Binance endpoint.

#### What goes in the 402 response body

The docs describe the merchant's obligation but never give a normative buyer-side schema. Field
mapping the merchant must satisfy [docs: /products/onchainpay-x402/basics/8.typical-integration-flow]:
`paymentRequirements.extra` must carry `name`, `version`, `assetTransferMethod`, `signerAddress`,
and `spenderAddress` (permit2 only), copied verbatim from the merchant's cached `/supported`.

The real wire shape, observed on a live BSC-capable endpoint [measured: 2026-09-06]:

```jsonc
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": { "url": "...", "description": "...", "mimeType": "" },
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:56",
    "asset": "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",  // USD1
    "amount": "10000000000000000",                           // 0.01 @ 18 decimals
    "payTo": "0x...",
    "extra": {
      "name": "World Liberty Financial USD",
      "version": "1",
      "assetTransferMethod": "eip3009",
      "signerAddress": "0x34F7a661160780Ce1346e6D7B96D2bE244590899"
    }
  }]
}
```

> **This is the finding that unblocks you.** The docs assert buyers have "no other channel" to learn
> `signerAddress` / `spenderAddress` than a cooperating merchant. In practice B402's **production
> facilitator addresses are constant across merchants and published in every live 402**. I observed
> identical values from two unrelated merchants (Nansen, CoinMarketCap) [measured: 2026-09-06]:
>
> - `signerAddress` (facilitator EOA): `0x34F7a661160780Ce1346e6D7B96D2bE244590899`
>   — verified EOA on BSC (`eth_getCode` → `0x`), nonce `0x4d39` = **19,769 transactions**
> - `spenderAddress` (Permit2 proxy): `0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633`
>   — verified **deployed contract** on BSC (`eth_getCode` returns bytecode)
>
> Caveat, and take it seriously: the docs say *"`spenderAddress` changes if b402 redeploys the proxy
> contract. Always read it fresh from `/supported` rather than hard-coding"*
> [docs: .../4.permit2-signing]. Read it from the live 402 per request — never hardcode.

#### Which header carries the signed payment on retry

**Binance's core x402 docs never name it.** Step 5 says only *"attaching the signed payment payload
in the request header"* [docs: .../8.typical-integration-flow]. Quick Start names
`X-PAYMENT-REQUIREMENTS` but that is the **merchant→buyer** direction, not the retry
[docs: /products/onchainpay-x402/quick-start]. This is a genuine documentation gap.

Resolved from two other sources:

- **x402 v2 → `PAYMENT-SIGNATURE`.** *"For x402 v2 this is always `PAYMENT-SIGNATURE`"*
  [repo: .../binance-agentic-wallet/references/x402-payment.md]. Response settlement metadata comes
  back in a `PAYMENT-RESPONSE` header (base64 JSON, carries `txHash`).
- **x402 v1 → `X-PAYMENT`.** Live v1 endpoints return `{"error":"X-PAYMENT header is required"}` and
  advertise `Access-Control-Allow-Headers: Content-Type, PAYMENT-SIGNATURE, X-PAYMENT`
  [measured: 2026-09-06].

#### The EIP-712 payloads

**Permit2 (`permit2-exact`) — fully documented** [docs: .../4.permit2-signing]. Domain is
**three fields, no `version`** (adding one breaks the domain separator):

```json
{ "name": "Permit2", "chainId": 56,
  "verifyingContract": "0x000000000022D473030F116dDEE9F6B43aC78BA3" }
```

`primaryType: "PermitWitnessTransferFrom"`; types `PermitWitnessTransferFrom(permitted,
spender, nonce, deadline, witness)`, `TokenPermissions(token, amount)`, `Witness(to, validAfter)`.
Field order is load-bearing and the struct must be named exactly `Witness`. `spender` is the
**Permit2 proxy** (`extra.spenderAddress`), *not* the facilitator EOA. Requires a one-time
`token.approve(permit2, 2^256-1)` from the payer wallet — `/verify` does **not** check this, so a
missing approval surfaces only as an on-chain revert at `/settle`.

**EIP-3009 — typed data is NOT documented.** The docs give the wire object
(`from/to/value/validAfter/validBefore/nonce`) [docs: .../2.verify-payment] but defer signing to
`@x402/evm` and never publish the `TransferWithAuthorization` typed-data struct. You'd take it from
the EIP-3009 standard and the token's own domain (`extra.name` / `extra.version`). Flagged as a gap;
don't treat the struct as Binance-specified.

#### Can you implement a buyer with viem/ethers, no Agentic Wallet?

**Yes, unambiguously.** Signing is *"a pure local operation — no RPC needed"* [docs: .../4.permit2-signing],
and Binance ships working viem **and** ethers v6 reference implementations on that page. Nothing in
the buyer path calls a credentialed endpoint. Minimal path:

```
1. POST the resource                        → 402 + accepts[]
2. Pick an accepts[] entry you can pay      (check network/asset/method against your wallet)
3. Sign EIP-712 locally (viem)              → signature + permit2Authorization | authorization
4. base64(JSON({x402Version, ...payload}))  → header value
5. Retry with PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1)
6. Merchant runs /verify + /settle for you; read PAYMENT-RESPONSE for txHash
```

Prerequisites you own: a funded BSC wallet, and for permit2 a one-time Permit2 approval. **No BNB
for gas** — B402 sponsors gas on settle [docs: /products/onchainpay-x402/introduction].

> ⚠️ **Decimals trap.** All four BSC tokens (U, USD1, USDC, USDT) are **18 decimals**, not 6 — a
> changelog entry records merchants who assumed 6 and *"were charging 1e-14 of a token"*
> [docs: /products/onchainpay-x402/change-log, 2026-05-19]. **The V2 API examples still use 6-decimal
> amounts** (`"amount": "1000000"` for BSC USDC) [docs: .../2.verify-payment], contradicting that
> fix. Live 402s use `10000000000000000` (1e16 = $0.01 at 18dp) [measured: 2026-09-06]. Trust the
> live wire, not the examples.

---

### Q2 — B402 seller side

**To charge per request via B402 you must run two calls, both credentialed:**

- `POST {BASE_URL}/papi/v2/b402/verify` — off-chain signature check, no gas. Returns
  `{isValid, payer, invalidReason?, invalidMessage?}`. **100 req/s** per merchant.
- `POST {BASE_URL}/papi/v2/b402/settle` — irreversible on-chain execution, gas sponsored. Returns
  `{success, transaction, payer, network, amount?, errorReason?}`. **20 req/s** per merchant.
  [docs: .../2.verify-payment, .../3.settle-payment, /products/onchainpay-x402/integration-guideline]

Settlement is **asynchronous since 2026-07-14** and this is a breaking behavior you must design for:
`/settle` returns within ~20s or emits a *Pending* result (`success: false` **with** a `transaction`
hash). You must **poll** `/settle` (idempotent) until `success: true` or terminal failure. Only
`transaction: ""` is a guaranteed terminal failure; `invalid_transaction_state` with a non-empty hash
is ambiguous between a revert and a pending timeout. Poll beyond `maxTimeoutSeconds` — the backend
reconciles for up to ~30 min [docs: /products/onchainpay-x402/change-log].

**Onboarding requirements** [docs: .../6.apply-developer-account] — via
`https://forms.gle/aUQvxUETfGMzyTky5`, **separately per environment** (testnet and mainnet
credentials are not shared):

- business name, contact email
- EVM wallet address to receive funds
- **RSA public key** (PKCS#8) for request signing
- **source IP addresses** for whitelisting
- webhook callback URL (if applicable)

Binance then issues `clientId`, `accessToken`, and the **base URL itself**. Request signing is
RSA-SHA256 over headers `X-Tesla-ClientId`, `X-Tesla-SignAccessToken`, `X-Tesla-Timestamp`,
`X-Tesla-Signature` [docs: /products/onchainpay-x402/quick-start].

**Is there a testnet?** Yes — Sandbox on BSC Testnet (chain 97). But the base URL is *"Please contact
us for access"* for **both** sandbox and production [docs: .../4.base-urls]. There is no
self-service testnet.

**Can you stand up a paid endpoint today? No — not a B402-settled one.** The blocker is not code, it
is a human-in-the-loop application with IP whitelisting and key registration. Nothing in the docs
suggests same-day issuance. Assume this is out of scope for 36 hours.

You *could* run an x402 endpoint today against a non-Binance facilitator (Coinbase CDP) — which is
what most of the Bazaar actually does (§Q3) — but that does **not** get you into the Bazaar, because
listing requires a confirmed **V2 settle through B402** [docs: /products/onchainpay-x402/b402-bazaar].

---

### Q3 — B402 Bazaar

**It exists, it's open, and it's genuinely live.** Verified [measured: 2026-09-06].

Base URL is stable and explicitly safe to hardcode; **no authentication**
[docs: /products/onchainpay-x402/basics/4.base-urls]:

```
https://www.binance.com/bapi/ramp/v1/public/ramp/b402
```

| Endpoint | Params | Default/max limit | `data` key |
|---|---|---|---|
| `GET /bazaar/resources` | `limit`, `offset` | 25 / 100 | `items[]` |
| `GET /bazaar/merchant` | **`payTo`** (req), `limit`, `offset` | 25 / 100 | `resources[]` |
| `GET /bazaar/search` | `query`, `network`, `asset`, `scheme`, `payTo`, `maxUsdPrice`, `limit` | 20 / 20 (**no offset**) | `resources[]` |

Responses wrap the CDP-shape catalog in Binance's BAPI envelope
`{code, message, messageDetail, data, success}` — CDP-built clients must unwrap one extra layer.
All three endpoints and the `scheme` filter confirmed working [measured: 2026-09-06].

**How an agent enumerates:** page `/bazaar/resources` with `limit=100&offset=N`. I pulled the full
catalog this way: **979 resources**, `pagination.total: 979`.

#### What the catalog actually contains — and why you must not trust it

I crawled all 979 entries and probed one endpoint per unique host [measured: 2026-09-06]:

| Metric | Value |
|---|---|
| Resources | 979 |
| Unique hosts | **84** |
| Unique merchant wallets (`payTo`) | **8** |
| Resources from one operator (`*.theaslangroupllc.com`) | **941 = 96.1%** |
| Hosts returning a live 402 | 79 / 84 |
| Live 402s advertising **x402 v1** (Base only) | **76** |
| Live 402s advertising **x402 v2** (multi-chain) | **3** |
| Hosts actually offering a **BSC / `eip155:56`** payment option | **3 of 79** |

**The catalog says 979/979 resources are on `eip155:56` with B402 schemes. Only 3 of 84 hosts
actually serve a BSC-payable 402.** The other 76 serve `x402Version: 1` on Base with USDC and demand
an `X-PAYMENT` header — a Coinbase-CDP-shaped paywall, not a B402 one.

The catalog's `accepts[]` reflects **the chain the merchant settled on when they registered**, not
what their endpoint currently advertises. An agent that reads the Bazaar and signs against the
catalog will produce a payment the endpoint won't accept. **Always re-fetch the live 402 before
signing.** This single discrepancy is the most exploitable thing I found (see §6.1).

The three genuinely BSC-payable hosts are `api.nansen.ai`, `pro-api.coinmarketcap.com`, and
`api.syraa.fun` — all offering `eip3009` and/or `permit2-exact` on U / USD1 / USDT / USDC at ~$0.01.

**MCP access to the Bazaar is not documented.** The docs say agents can use *"the `search_resources`
tool on Bazaar's hosted MCP endpoint"* [docs: .../b402-bazaar] but **never publish a URL**, and my
two plausible guesses returned 404 [measured: 2026-09-06]. Treat as not shipped; use REST.

---

### Q4 — Agentic Wallet x402: which source is right?

**x402 is shipped.** The conflict is real but it resolves cleanly — the *product doc page is stale*,
the *CLI and skill are ahead of it*.

| Source | Says | Verdict |
|---|---|---|
| `/products/agentic-wallet/welcome` "Core Capabilities" table lists only Authentication, Wallet, Market Order, Limit Order, Prediction Market, then *"More features coming soon."* [docs] | implies no x402 | **Stale.** It also omits DeFi, approvals, and external signing — all of which ship. |
| Skills Hub trigger list includes "x402 payment, HTTP 402 Payment Required" [repo: .../binance-agentic-wallet/SKILL.md] | x402 supported | **Correct** |
| `references/x402-payment.md` — full command reference [repo] | shipped | **Correct** |
| npm `@binance/agentic-wallet@1.9.0`, published **2026-08-27**; skill v1.11.0 declares `requiredCliVersion: 1.9.0` [measured] | shipped | **Correct** |

#### What `baw` actually exposes

Two x402 commands [repo: .../references/x402-payment.md]:

- **`baw x402-payment preview --paymentRequirements <base64-or-raw-json> --json`** — takes the
  merchant's 402, returns a `paymentId` and a **pre-sorted, pre-validated** `options[]`, each with
  `status` ∈ `READY_TO_SIGN` / `ACTION_REQUIRED` / `NOT_SIGNABLE`, plus your live `currentBalance`,
  `amountUsd`, and `needApproveFirst`. Failure reasons are enumerated: `INSUFFICIENT_BALANCE`,
  `UNSUPPORTED_NETWORK`, `UNSUPPORTED_SCHEME`, `UNSUPPORTED_METHOD`, `NO_WALLET_ON_CHAIN`,
  `BLOCKED_BY_SECURITY_CHECK`, `BLOCKED_DAILY_LIMIT_REACHED`.
- **`baw x402-payment sign --paymentId <id> --selectedIndex <n> --json`** — returns
  `{paymentHeaderName, paymentHeaderValue, approveTxHash, binanceChainId, signatureExpiresAt}`.
  Single-use signature. If `approveTxHash` is non-null (Permit2 first use) you must wait for it to
  confirm before replaying — **and on BSC that approve's gas is sponsored.**

**Documented limits:** *"Only x402 v2 is supported"* and *"Only BSC, Base, and Solana are supported.
Ethereum is not supported."* Supported transfer methods: `eip3009`, `permit2`, `spl-transfer`.

> **This is a load-bearing constraint for your build.** `baw x402-payment` is **v2-only**, but
> **76 of 79 live Bazaar endpoints emit v1** [measured: 2026-09-06]. Binance's own wallet cannot pay
> the overwhelming majority of Binance's own discovery catalog. See §6.3 for the workaround.

**The full `baw` surface** (all commands take `--json`) [repo: .../binance-agentic-wallet/SKILL.md]:

`auth signin|verify|signout` · `wallet status|chains|address|balance|tx-history|settings|tx-lock|speed-up|cancel|send` ·
`approvals list|detail|revoke` · `market-order swap|quote|list` · `limit-order buy|sell|list|cancel` ·
`contract-call preview|execute` · `sign-message preview|execute|result|history` ·
`prediction category list`, `prediction market list|detail|search|order-book|last-trade-price`,
`prediction position list|token|settled-history|pnl|portfolio`, `prediction order history`,
`prediction trade quote|place-order|cancel|redeem` · `x402-payment preview|sign` ·
`defi protocol-list|protocol-info|investment-list|investment-info|position|deposit|redeem|lp-add|lp-remove|claim|preview`

---

### Q5 — The confirm gate, and headless viability

**These are two different systems with two different answers. Don't conflate them.**

#### Binance MCP server — gate is asserted, headless is closed

The doc states *"Every trade / transfer — Confirmed by you first"* and *"This confirm-before-execute
pattern applies to every non-read action — orders, cancels, and transfers"*
[docs: /agent-native/mcp-server/agentic]. **No scope, setting, or API path for unattended execution
is documented.** I found no bypass. Note the docs never state *where* this is enforced (client-side
convention vs server-side) — **not documented**.

Hard properties that *are* stated: there is **no withdrawal scope**, ever — the agent *"can never
move funds out of the sub-account to an external address"*; the agent also cannot pull funds from
your main account, so the first deposit is always a manual human step in the web UI. Scopes are
Market data / Account / Trade / Transfer (intra-sub-account only), chosen at consent time and
changeable only by disconnect + reconnect. There's an **Emergency stop** that disconnects all agents
and cancels all orders in one action.

**Is the OAuth session usable headless / server-side? No documented path.** From the live metadata
[measured: 2026-09-06] at `https://agent.binance.com/.well-known/oauth-authorization-server`:

```json
{"issuer":"https://agent.binance.com",
 "authorization_endpoint":"https://accounts.binance.com/agentic-oauth/authorize",
 "token_endpoint":"https://accounts.binance.com/oauth-agentic/token",
 "token_endpoint_auth_methods_supported":["none"],
 "response_types_supported":["code"],
 "grant_types_supported":["authorization_code"],
 "code_challenge_methods_supported":["S256"],
 "client_id_metadata_document_supported":true}
```

`grant_types_supported` is **`["authorization_code"]` only** — no `client_credentials`, no
`refresh_token` advertised. It is a public PKCE client requiring interactive browser consent. There
is no machine-to-machine grant. Unauthenticated `tools/list` returns **401** with
`WWW-Authenticate: Bearer resource_metadata=".../oauth-protected-resource/gateway-mcp"`
[measured: 2026-09-06]. The docs further frame it as desktop-bound: *"this feature is built for
desktop, not mobile"*, and warn against pasting the endpoint into a chat.

Nothing forbids a server from *holding* a token obtained interactively, but no token lifetime,
refresh, or headless flow is documented. Treat unattended MCP as unavailable.

#### Agentic Wallet — genuinely unattended, within quotas

This is the opposite story and it's where your leverage is.

**The confirm gate here is explicitly soft.** The skill's own guardrails read: *"Confirm with the
user before calling `sign` and only proceed once they've consented, **unless the user explicitly asks
to skip confirmation**"* [repo: .../references/x402-payment.md] — and the same waiver appears in the
SKILL.md's global rule [repo: .../binance-agentic-wallet/SKILL.md]. That is a **prompt-level
instruction to the model, not an API gate**, and it is documented as waivable by the user.

**The hard gates are elsewhere, and they are server-side.** The wallet doc states rules *"constrain
the Agent at the API level. Any action outside your rules is automatically rejected or requires a
second confirmation"* [docs: /products/agentic-wallet/welcome]. From `wallet settings`
[repo: .../references/wallet-setting.md] — **all read-only from the CLI; changeable only in the
Binance App**:

| Gate | Example value | Notes |
|---|---|---|
| `x402DailyLimit` | **20 USD** | **Independent bucket.** x402 spend only consumes `x402QuotaUsed`. |
| `dailyLimit` | 50,000 USD | general transactions |
| `predictionDailyLimit` | 50,000 USD | independent bucket |
| `defiDailyLimit` | 5,000 USD | independent bucket |
| `devMode.dailyLimit` | 10,000 USD | independent bucket; external signing |
| `maxSigninDuration` | 48h | then forced sign-out |
| `inactiveSignoutDuration` | 48h | **fixed, not user-configurable** |
| `abnormalTxnHandling` | `AutoReject` \| `NeedConfirmation` | `NeedConfirmation` pushes a real double-confirm to the phone |
| `tradeAllTokens` | false | allowlist-only when false |

**Headless verdict:** `auth signin` → `auth verify` requires a **one-time QR scan in the Binance
Wallet App** (`auth verify` blocks up to 5 min and must not be backgrounded)
[repo: .../references/authentication.md]. After that the session is local and every command runs
unattended for up to 48h. **So: one human action at t=0, then autonomous.** That is a real
unattended-execution path — bounded by the quota buckets above, not by a confirmation prompt.

---

### Q6 — What's actually callable

**Binance MCP server tool names and parameters: NOT DOCUMENTED.** I looked in the full docs dump and
the page lists only capability categories, never tool names. `tools/list` is 401-gated
[measured: 2026-09-06], so I cannot enumerate them without an interactive OAuth consent I can't
perform here. **Do not plan around specific MCP tool names you haven't seen.** All that's documented:

- **Market data** (public, no auth) — tickers, order books, candlesticks, funding rates
- **Account** — Agentic sub-account balance, positions, bills; optional read-only main-account view
- **Trade** — Spot, Margin, Convert, USDⓈ-M Futures, COIN-M Futures
- **Transfer** — between wallets *inside* the same Agentic sub-account only

Endpoint: `https://agent.binance.com/mcp/agentic` (HTTP transport). Clients with documented setup:
Claude Code, Claude Desktop, Codex CLI, ChatGPT web, ChatGPT/Codex Desktop, VS Code, Grok Bot
(`oauth_client_id = "grok"`) [docs: /agent-native/mcp-server/agentic].

**The concrete, verifiable tool surface you can actually enumerate today is the `baw` CLI** — listed
in full in §Q4 — plus the Bazaar REST endpoints in §Q3. Both are in the appendix as runnable commands.

---

## 3. Announced but not usable yet

| Item | Claim | Reality |
|---|---|---|
| **Bazaar hosted MCP endpoint** | *"the `search_resources` tool on Bazaar's hosted MCP endpoint"* [docs: .../b402-bazaar] | **No URL published anywhere in the docs.** Guessed paths 404 [measured]. Use REST. |
| **Bazaar `quality` signals** | Docs example shows `quality: {l30DaysTotalCalls, l30DaysUniquePayers, lastCalledAt}` [docs: .../b402-bazaar] | **Absent from every live response** I retrieved [measured]. Ranking is described but the signal isn't exposed. |
| **`/v1/b402/discovery/*`** | Changelog 2026-06-04 calls it *"the upcoming ... API"* | Superseded by `/bazaar/*` on 2026-06-23. Dead path — don't code to it. |
| **Multi-tier pricing in Bazaar** | *"Multi-tier listings are on the roadmap"* | Not shipped. One listing per `(merchantId, resourceUrl)`. |
| **Marketing-only Bazaar listings** | *"Not in v0"* | Listing strictly requires a successful V2 settle. |
| **Non-BSC B402 networks** | *"Expansion to other EVM-compatible networks is planned"* [docs: /products/onchainpay-x402/introduction] | B402 settles **BSC only**. (`baw` separately supports Base/Solana — different system.) |
| **`permit2-upto` buyer docs** | Scheme is specified and used in `/settle` via `settleAmount` | Signing guide explicitly excludes it: *"out of scope for this page — contact the B402 team"* [docs: .../4.permit2-signing]. **Not buildable from docs.** |
| **Agentic Wallet "Core Capabilities"** | *"More features coming soon"* [docs: /products/agentic-wallet/welcome] | Stale — x402, DeFi, approvals, external signing already ship. |
| **Skills Hub count** | *"8 Skills are currently published"* [docs: /products/wallet-skills/overview] | Repo has **12** under `binance-web3` (+7 under `binance`) = 19 [repo]. Docs lag. |
| **Hackathon rules** | — | **Not in any Binance developer doc, the Agent OS page, or the linked blog post** [measured: all three fetched]. Track A details ($20K; demo/video + GitHub + survey; Sept 8 deadline) exist only in third-party press. **Verify against the official rules yourself — I could not find a primary source.** |

---

## 4. Hard constraints — things you cannot do, no matter what

1. **You cannot become a B402 merchant in 36 hours.** `/verify` and `/settle` require clientId +
   accessToken + registered RSA public key + **IP whitelist**, issued by humans via a Google Form,
   **separately per environment**. Even the base URL is withheld until onboarding. No self-service,
   no sandbox shortcut. [docs: .../6.apply-developer-account, .../4.base-urls]
2. **You therefore cannot list anything in the Bazaar.** Indexing is triggered *only* by a confirmed
   V2 settle carrying `extensions.bazaar`. *"Can I submit a listing without settling? Not in v0."*
   [docs: .../b402-bazaar]
3. **No withdrawals via MCP, ever.** No withdrawal scope exists; funds cannot leave the Agentic
   sub-account to an external address. The first deposit is always a manual human web-UI action.
   [docs: /agent-native/mcp-server/agentic]
4. **No headless Binance MCP.** `authorization_code` + PKCE only; no `client_credentials`.
   Interactive browser consent required. [measured]
5. **Agentic Wallet needs one phone scan, and dies at 48h.** `maxSigninDuration` 48h;
   `inactiveSignoutDuration` 48h is **fixed and not user-configurable**. Any demo must either
   re-authenticate or fit inside the window. [repo: .../authentication.md, .../wallet-setting.md]
6. **`x402DailyLimit` is ~20 USD** and settable only in the Binance App. Budget your demo's spend.
   [repo: .../wallet-setting.md]
7. **`baw x402-payment` is x402-v2-only and BSC/Base/Solana-only.** It cannot pay the 76 v1 endpoints
   that make up ~96% of the Bazaar. [repo: .../x402-payment.md + measured]
8. **B402 settles on BSC only.** Everything with `network: "base"` in the Bazaar is *not* going
   through B402. [docs: /products/onchainpay-x402/introduction]
9. **Settlement is async and irreversible.** You must poll; you must not key success on HTTP status
   (always 200); `success:false` **with** a tx hash is not terminal. [docs: /change-log]
10. **Permit2 needs a prior on-chain approval** that `/verify` does not check — it fails only at
    settle. [docs: .../4.permit2-signing]

---

## 5. Recommended architecture for 36 hours

Build a **buyer-side agent**, not a seller. Concretely:

- **Discovery:** Bazaar REST (no auth, works now).
- **Payment:** your own viem signer (no auth, no onboarding) — with `baw x402-payment` as an
  optional "custodial mode" toggle for the demo's credibility.
- **Never** depend on B402 merchant credentials, the Bazaar MCP endpoint, `permit2-upto`, or
  specific Binance MCP tool names.

---

## 6. Three capability combinations nobody is likely to use

Each is unblocked by the constraints above, uses only what I verified live, and is unlikely to be
duplicated — because each depends on a fact you only learn by *probing* rather than reading.

### 6.1 The Bazaar conformance oracle — "the catalog is lying, and I can prove it"

**The gap.** Everyone who touches the Bazaar in this hackathon will `GET /bazaar/search`, read
`accepts[]`, and build against it. **It is wrong for 76 of 79 live hosts** — the catalog claims 100%
BSC while the endpoints actually demand x402 v1 on Base [measured: 2026-09-06]. Nobody will notice,
because noticing requires crawling all 979 entries and probing every host, which takes a script and
about ten minutes of nerve.

**Build:** a crawler that, for every Bazaar resource, fetches the live 402 and diffs it against the
catalog — emitting a **trust score** per resource (`catalog_matches_live`, `x402_version_actual`,
`networks_actual`, `is_bsc_payable`, `responds_at_all`). Serve it as (a) an MCP server exposing
`find_payable_resource(budget, network, wallet_assets)` that returns only resources your wallet can
*actually* pay right now, and (b) a public leaderboard of catalog drift.

**Why it wins.** It's the only Track A entry that could ship a *finding* rather than a demo: 96.1% of
the catalog is one operator, 8 merchant wallets total, 3 of 84 hosts are BSC-payable. It's
defensible (I've verified every number), it needs zero credentials, and it makes every other
x402 agent in the hackathon work better. It also directly serves Binance's interest — you're handing
them their own data-quality bug with receipts.

**Risk:** be scrupulous about framing — this is a conformance report, not an accusation. Probe
politely (one request per host, cache aggressively).

### 6.2 The credential-free B402 buyer — pay Nansen and CoinMarketCap with no Binance account

**The gap.** The docs state buyers *"cannot"* obtain the facilitator addresses and depend entirely
on a cooperating merchant. Everyone will read that and conclude the buyer path needs onboarding — or
they'll just use `baw` and inherit its v2-only, 20-USD-a-day limits. **But the addresses are constant
and published in every live 402, and I verified both on-chain** [measured: 2026-09-06]:
facilitator EOA `0x34F7…0899` (19,769 txs), Permit2 proxy `0x3038…8633` (deployed contract).

**Build:** a ~200-line viem buyer that pays **real, brand-name endpoints** — Nansen address balances,
CoinMarketCap DEX search — on BSC with USD1/U via `eip3009`, or USDT/USDC via `permit2-exact`, for
$0.01 a call, gas sponsored, from a plain private key. Wrap it as an MCP tool
(`paid_fetch(url, max_usd)`) so any agent gains paid-API access with no keys, no accounts, no
subscriptions.

**Why it wins.** A live demo of an agent autonomously buying Nansen data for one cent with no API key
and no Binance relationship is a *much* stronger artifact than another wallet wrapper — and it's the
purest expression of what x402 is for. It also composes with 6.1: the oracle tells you *what's
payable*, this pays it.

**Watch for:** re-read `spenderAddress` from each 402 (docs warn it changes on redeploy); handle the
one-time Permit2 approval; encode against **18 decimals**.

### 6.3 Independent quota buckets + `sign-message` as a v1 escape hatch

**The gap, part one.** `baw`'s daily limits are **separate buckets** — x402 (~20 USD), prediction
(50k), DeFi (5k), devMode (10k), general (50k) — each explicitly *"independent from"* the others
[repo: .../wallet-setting.md]. Nobody will compose across them, because nobody reads the settings
reference. But it means an agent can **pay for its own inputs out of the x402 bucket and act on them
out of the prediction bucket**, with the spend caps never colliding.

**The gap, part two.** `baw x402-payment` is v2-only and so cannot pay the 76 v1 Bazaar endpoints.
But `baw sign-message preview|execute` performs **arbitrary EIP-712 signing** through the same MPC
wallet under `devMode` (its own 10k quota). An x402 v1 EIP-3009 authorization *is* just an EIP-712
message. So `sign-message` is a **documented, in-product path to pay the v1 endpoints that Binance's
own x402 command refuses** — using Binance's own MPC custody rather than a raw private key.

**Build:** a closed research→bet loop. Agent buys market intelligence over x402 (bucket 1), forms a
view, places a position on Binance prediction markets via `prediction trade place-order` (bucket 2),
and tracks realized PnL via `prediction position pnl` — the whole loop unattended inside one 48h
session after a single QR scan. Add the `sign-message` shim so the x402 leg can reach the v1
majority of the catalog.

**Why it wins.** It's the only design that makes the *quota architecture itself* the feature, and it
demonstrates a genuinely autonomous economic agent — one that pays for its own information — while
staying entirely inside Binance's stated safety envelope.

**Handle with care.** `sign-message` requires `devMode.enabled = true` (set in the Binance App only),
and the skill mandates showing the parsed message and risks before `execute`
[repo: .../binance-agentic-wallet/SKILL.md]. Keep that confirmation in your demo — waiving it is
documented as permitted, but a judge will read an explicit, visible consent step as a strength, not a
limitation. Use trivial amounts, and don't present PnL as investment advice.

---

## Appendix — reproduce every measurement

```bash
# Docs corpus (8.0 MB, 802 documents)
curl -s https://developers.binance.com/en/docs/llms-full.txt -o llms-full.txt

# Bazaar is live, unauthenticated, 979 resources
curl -s "https://www.binance.com/bapi/ramp/v1/public/ramp/b402/bazaar/resources?limit=3"
curl -s "https://www.binance.com/bapi/ramp/v1/public/ramp/b402/bazaar/search?query=BTC+price&limit=2"
curl -s "https://www.binance.com/bapi/ramp/v1/public/ramp/b402/bazaar/merchant?payTo=0x50ab2018c06c6E4eAA9BA52057Eb55eD284912fc&limit=2"

# A live 402 that IS BSC-payable — note signerAddress / spenderAddress in extra
curl -s -X POST https://api.nansen.ai/api/v1/profiler/address/current-balance \
  -H 'Content-Type: application/json' -d '{}'
curl -s -X POST https://pro-api.coinmarketcap.com/x402/v1/dex/search \
  -H 'Content-Type: application/json' -d '{}'

# A live 402 that is NOT (x402 v1, Base, X-PAYMENT) — 76 of 79 hosts look like this
curl -s -X POST https://cryptopulse.theaslangroupllc.com/api/options-greeks \
  -H 'Content-Type: application/json' -d '{}'

# Facilitator EOA: no code, 19769 txs
curl -s -X POST https://bsc-dataseed.binance.org/ -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_getTransactionCount","params":["0x34F7a661160780Ce1346e6D7B96D2bE244590899","latest"],"id":1}'
# Permit2 proxy: deployed contract
curl -s -X POST https://bsc-dataseed.binance.org/ -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_getCode","params":["0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633","latest"],"id":1}'

# MCP server: 401, and the OAuth grant set
curl -si -X POST https://agent.binance.com/mcp/agentic -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -5
curl -s https://agent.binance.com/.well-known/oauth-authorization-server

# baw CLI version
curl -s https://registry.npmjs.org/@binance/agentic-wallet | grep -o '"latest":"[^"]*"'

# Skills Hub
git clone --depth 1 https://github.com/binance/binance-skills-hub.git
```

**Not verified / explicitly out of scope:** I did not sign, submit, or settle any payment, and did
not authenticate to the MCP server or the Agentic Wallet. All payment-path claims are from
documentation plus unauthenticated 402 challenges and public read-only chain queries.
