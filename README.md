# @arkade-os/lnurl

LNURL service that enables amountless Lightning receives for Arkade wallets, with optional SQLite persistence, LN Address (LUD-16) serving, and a React admin UI.

## Flow — ephemeral LNURL-pay (always available)

```
Wallet                    Service                     Payer
  │                          │                          │
  │── POST /lnurl/session ──▶│                          │
  │◀── SSE: session_created ─│                          │
  │    { sessionId, lnurl }  │                          │
  │                          │◀── GET /lnurl/:id ───────│
  │                          │── payRequest metadata ───▶│
  │                          │                          │
  │                          │◀── GET /lnurl/:id/cb ────│
  │                          │    ?amount=50000         │
  │◀── SSE: invoice_request ─│    (holds response)      │
  │    { amountMsat }        │                          │
  │                          │                          │
  │── POST /session/:id/ ───▶│                          │
  │   invoice { pr: "lnbc…" }│── { pr: "lnbc…" } ─────▶│
  │                          │                          │
  │── (close SSE) ──────────▶│  LNURL deactivated       │
```

## Endpoints

### Core SSE session (always available)

| Method | Path | Caller | Purpose |
|--------|------|--------|---------|
| POST | `/lnurl/session` | Wallet | Opens SSE stream; returns `session_created` with `sessionId` and `lnurl` |
| GET | `/lnurl/:id` | Payer | LNURL-pay first call (LUD-06) — returns pay metadata |
| GET | `/lnurl/:id/callback?amount=<msat>` | Payer | Requests invoice; notifies wallet via SSE |
| POST | `/lnurl/session/:id/invoice` | Wallet | Wallet posts `{ pr: "<bolt11>" }` to resolve the pending payer request |
| GET | `/lnurl/verify/:paymentHash` | Payer | LUD-21 — poll settlement; returns `{ settled, preimage, pr }` |
| POST | `/lnurl/session/:id/settled` | Wallet | Wallet reports `{ preimage }` once its invoice settled (feeds `verify`) |

### LN Address / LUD-16 (requires `DB_PATH`)

| Method | Path | Caller | Purpose |
|--------|------|--------|---------|
| GET | `/.well-known/lnurlp/:username` | Payer | LUD-16 resolution — returns pay metadata; error if wallet is offline |
| GET | `/.well-known/lnurlp/:username/callback` | Payer | Invoice callback for LN address payments |
| POST | `/lnurl/address` | Wallet | Register/claim a Lightning address |
| GET | `/lnurl/address` | Wallet | List own addresses (`Authorization: Bearer <token>`) |
| GET | `/lnurl/domain` | Wallet | What the domain allows: allocation modes (`self`, `random`, `admin`, `session`) and username rules |
| PATCH | `/lnurl/address/:handle` | Wallet | Give a nameless receiver a name in place; its LNURL keeps working (`Authorization: Bearer <token>`) |
| DELETE | `/lnurl/address/:handle` | Wallet | Revoke own address (`Authorization: Bearer <token>`) |
| POST | `/lnurl/address/:handle/arkade` | Wallet | Register Arkade receive identity for offline receive (`Authorization: Bearer <token>`) |

## Usage

### As a library

```ts
import { createServer } from "@arkade-os/lnurl";

const app = createServer({
  port: 3000,
  baseUrl: "https://lnurl.example.com",
  minSendable: 1_000,        // 1 sat in millisats
  maxSendable: 100_000_000,  // 100k sats in millisats
  invoiceTimeoutMs: 30_000,
});

app.listen(3000);
```

### Standalone

```bash
PORT=3000 \
BASE_URL=https://lnurl.example.com \
MIN_SENDABLE=1000 \
MAX_SENDABLE=100000000000 \
INVOICE_TIMEOUT_MS=30000 \
pnpm dev
```

### Docker

```bash
docker run -p 3000:3000 \
  -e BASE_URL=https://lnurl.example.com \
  -e DB_PATH=/data/lnurl.db \
  -e TOKEN_ENCRYPTION_KEY=<32-byte-hex> \
  -e BOOTSTRAP_DOMAIN=pay.example.com \
  -v /host/data:/data \
  ghcr.io/arklabshq/lnurl-server:latest
```

The image runs as the unprivileged `node` user, writes state only under `/data`, and checks `/readyz`. For the single-instance reference deployment and backup/restore procedure, see [`compose.production.yml`](compose.production.yml) and [`docs/operations.md`](docs/operations.md). The admin port (3001) is not published in the example above.

## Wallet Integration

1. **Open session** — `POST /lnurl/session`. The response is an SSE stream. The first event is `session_created` with `{ sessionId, lnurl, token }`. Display the LNURL as a QR code.

2. **Listen for invoice requests** — When the payer scans and selects an amount, the wallet receives an `invoice_request` event with `{ amountMsat, comment }`.

3. **Create swap and reply** — Use `@arkade-os/boltz-swap` to create a reverse swap for the requested amount, then `POST /lnurl/session/:id/invoice` with `{ pr: "<bolt11>" }`.

4. **Report settlement (LUD-21, optional)** — After your invoice settles, `POST /lnurl/session/:id/settled` with `{ preimage }` (Bearer token). The server verifies `sha256(preimage)` matches the invoice's payment hash and flips the `verify` URL to `settled: true`, letting payers confirm the payment. Report while the session is still connected (or reconnect the reusable session first).

5. **Close session** — When done, close the SSE connection. The LNURL is immediately deactivated.

## SSE Events

| Event | Data | Description |
|-------|------|-------------|
| `session_created` | `{ sessionId, lnurl, token }` | Session is active, LNURL is ready to share |
| `invoice_request` | `{ amountMsat, comment? }` | Payer requested an invoice for this amount |
| `error` | `{ message }` | Something went wrong |

## Persistence (opt-in)

Without `DB_PATH` the service runs fully in-memory and behaves exactly as the original single-binary library — no database, no LN address provisioning, no admin UI.

Set `DB_PATH` to enable SQLite persistence:

```bash
DB_PATH=/data/lnurl.db \
TOKEN_ENCRYPTION_KEY=<32-byte-hex-or-base64> \
pnpm dev
```

The database uses Node's built-in `node:sqlite` module (requires `--experimental-sqlite`, wired automatically via the `NODE_OPTIONS` env var in the npm scripts).

### Encryption at rest

When `DB_PATH` is set, choose a private `TOKEN_ENCRYPTION_KEY` or explicitly set `ALLOW_INSECURE_TOKEN_STORAGE=1`. With a private key, wallet session tokens are stored with AES-256-GCM so a database dump alone cannot impersonate wallets. The insecure fallback makes no such confidentiality claim.

- `TOKEN_ENCRYPTION_KEY` — 32-byte secret, encoded as hex (64 chars) or base64 (44 chars).  
  Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `ALLOW_INSECURE_TOKEN_STORAGE=1` — explicit escape hatch that uses the source-known fallback key instead of requiring `TOKEN_ENCRYPTION_KEY`. It prevents accidental plaintext rows but provides no protection against anyone with the source and database. Use it only when that tradeoff is acceptable.

## LN Address (LUD-16)

When persistence is enabled the service can serve Lightning addresses (`user@domain.com`). Resolution is host-based: the `Host` header of the incoming request selects the domain. Multi-domain setups are supported by routing different hostnames to the same server instance. [docs/domains.md](docs/domains.md) covers setting a domain up, including one that already serves a site.

- **Online** — `/.well-known/lnurlp/:username` returns pay metadata and the callback triggers an invoice request to the wallet's live SSE session.
- **Offline** — if the wallet's SSE session is not active the callback returns an LNURL error (`status: "ERROR"`).

### Address provisioning

Wallets register a Lightning address via `POST /lnurl/address`. The request body must include a `token` (the wallet's session token). The `username` and `domain` fields determine which address is assigned:

| Request | Behaviour |
|---------|-----------|
| `username` provided, domain allows `"self"` mode | Wallet claims that specific username |
| no `username`, domain allows `"random"` mode | Server assigns a random username |
| a reserved address's `claimCode`, alone or with its `username` | Wallet claims that reserved address |
| `username` + a free-name `claimCode` | Wallet claims that username if it is available, even without `"self"` mode; the code is spent |

A `claimCode` that matches nothing, or was already spent, is refused with `invalid_claim`. A free-name code sent without a `username` gets `username_required`.

Constraints enforced per domain:
- **`allocationModes`** — which of `"self"`, `"random"`, `"admin"`, `"session"` the domain permits. `"session"` allows a receiver with no lightning address, reachable at `/lnurl/<sessionId>`.
- **`requireApiKey`** — if true, requests must include a valid `X-API-Key` header.
- **`max_per_session`** — cap on the active addresses a wallet takes for itself. Redeeming a claim code is never refused for it.
- **`username_min_len` / `username_max_len` / `username_pattern`** — username validation rules.
- **Blacklist** — per-domain and global username blacklist enforced at registration time.
- **Registration rate limit** — per-IP limit controlled by `REGISTRATION_RATE_LIMIT` (requests/min per IP).

## Offline receive (opt-in)

Normally an LN address only resolves while the wallet's SSE session is connected. With offline receive, a wallet can receive while disconnected: the server quotes a **solver-mediated swap over the Arkade intents corridor** (`lightning:BTC -> arkade:BTC`) and hands the payer the solver's hold invoice. When the payer pays, the solver funds a VHTLC pinned to the user's Arkade address, and **this server claims it** on the user's behalf — constrained by covenant (`enforcePayTo`) to pay only that address, so neither the solver nor the claimer can redirect funds. See [Self-claim](#self-claim-offline_self_claim), which is the intended configuration; a **covclaimd** daemon can claim the same leaf alongside it.

Enable it with the published registry for `ARKADE_NETWORK` (the default), an optional `SOLVER_REGISTRY_URLS` override, and/or `SOLVER_CARDS_FILE`, plus `ARK_SERVER_URL` — and `COVCLAIMD_URL`, unless `OFFLINE_SELF_CLAIM=true` (which omits the claim packet and claims without covclaimd). Discovery uses `@arkade-os/solver-discovery`, merges registry, startup-file, and admin-pasted cards, ranks compatible Lightning-receive markets, and fails over only before an invoice is accepted. No eligible card disables only offline receive; live wallet sessions still provide their own BOLT11 invoice. Pasted cards are managed in the admin UI's **Solvers** tab and activate immediately. A solver listed by pointer, in a registry or pasted, trades on the signed card it publishes over Nostr (see [Solver cards](docs/operations.md#solver-cards)). A wallet then registers its receive identity on an owned address:

> **When `COVCLAIMD_URL` is set, it must name the same covclaimd instance the solver reveals to.** The protocol does not carry that choice: this server seals the preimage to the key its own `COVCLAIMD_URL` reports, while the solver reveals to whichever daemon *its* operator configured. Point them at different daemons and every offline receive funds, fails to claim, and refunds — covclaimd correctly refuses a packet it cannot decrypt, the solver retries that refusal until the refund deadline, and the only trace is in the solver operator's logs, not yours. Until [arkade-os/intent-solver#46](https://github.com/arkade-os/intent-solver/issues/46) moves the choice in band, confirm the pairing with whoever runs the solver. Omitted (self-claim mode), the RFQ carries no `claim_packet` and there is nothing to pair.

```bash
curl -X POST https://pay.example.com/lnurl/address/alice/arkade \
  -H "Authorization: Bearer <session-token>" \
  -H "Content-Type: application/json" \
  -d '{"arkadeAddress":"tark1...","claimPublicKey":"02..."}'
```

After that, if a payer pays `alice@pay.example.com` while the wallet is offline, the server returns the solver's hold invoice and reports settlement through the LUD-21 `verify` URL (polled from the solver's RFQ status). The server never holds the user's keys or funds — it generates the swap preimage and hands it to covclaimd encrypted (sealed into the quote request, so it never touches the solver in plaintext).

> The corridor client is the published `@arkade-os/swap` package. The wire contract is integration-tested against fake HTTP services and was **live-probed against the public mutinynet solver** (`scripts/probe-solver.ts`) — quote, hold-invoice binding, and covenant derivation all verified. A full funded swap (payer pays, covclaimd claims) remains the operator's pre-production check.

### Self-claim (`OFFLINE_SELF_CLAIM`)

**This is how the offline rail is meant to run, and `.env.production.example` sets it.** covclaimd needs the sealed claim packet because it does not hold the preimage; this server generates it, so it can push the covenant's claim leaf itself with `OFFLINE_SELF_CLAIM=true` and `OFFLINE_EMULATOR_URL` set. `COVCLAIMD_URL` may then be omitted entirely: the RFQ carries no `claim_packet` (it is optional on the wire and the solver funds anyway) and the solver waits for this claim.

Leaving it off makes a third party the single point of failure for every receive — and `@arkade-os/swap`'s own documentation states covclaimd cannot claim this covenant today, so a covclaimd-only deployment claims nothing at all: the lockup goes unclaimed, the solver reclaims it at `refund_locktime`, and the payer is refunded while the receiver gets neither the money nor a local trace of why.

> It is on by default wherever `OFFLINE_EMULATOR_URL` is set, so `COVCLAIMD_URL` is no longer what makes the rail legal. Whether the rail runs at all is a separate question from who claims on it: an emulator is also the covenant rail's co-signer, so serving lightning swaps additionally requires something that only means that — solver cards, a registry override, `COVCLAIMD_URL`, `SOLVER_RFQ_HTTP_URL`, `NOSTR_SECRET_KEY`, or an explicit `OFFLINE_SELF_CLAIM=true`. A covenant-only deployment therefore keeps the swap rail off.

**Which leaf, and what pins the destination.** It spends the covenant's `nonInteractiveClaim` leaf — the same one covclaimd uses. That leaf is `preimage + Arkade operator + an emulator key tweaked by `enforcePayTo(receiverPkScript)``, where `receiverPkScript` is the user's registered Arkade address. Two things follow, and they are different claims:

- **This server cannot redirect the payout.** The leaf requires signatures from the Arkade operator and the emulator, and this server holds neither key. That follows from the tapscript alone.
- **No pusher can redirect it either** — but that one rests on the emulator, which derives its per-covenant key from `enforcePayTo(...)` and, by policy, signs only after checking the spend satisfies it. That check is what makes "anyone can push this leaf" safe by design.

**No key, and nothing taken from the user.** The server needs no key of its own, so there is no new secret to hold or rotate. The user keeps their `claimPublicKey` in the covenant's `receiver` role and with it the collaborative `claim` and `unilateralClaim` leaves, exactly as with the flag off. This is an additional pusher, not a transfer of control. The server still holds the preimage — it always did — so enabling this adds no custody it did not already have.

> The collaborative `claim` leaf is deliberately **not** used. It is a bare `preimage + receiver + operator` multisig with no output constraint, so a server holding the receiver key and the preimage could send a funded lockup anywhere. Spending it would make this server custodial for every in-flight swap.

> **`OFFLINE_EMULATOR_URL` must name the emulator whose key is baked into the covenant.** With `COVCLAIMD_URL` set that key comes from its `emulator_pub_key`, so the two must agree — point them at different emulators and every push is refused, the same pairing hazard as `COVCLAIMD_URL` itself. Without `COVCLAIMD_URL` the key comes straight from `OFFLINE_EMULATOR_URL`, which must then be the solver's emulator (the covenant has to match the solver's derivation). Startup checks the pairing when both are set and logs a warning naming both keys if they disagree; it never refuses to start, and it stays silent when either service is unreachable, so a boot-time blip is not mistaken for a misconfiguration. An emulator that has rotated its key still counts as a match, since covenants built under the retired key remain satisfiable.

When covclaimd is configured it keeps working alongside this: both push the same leaf to the same destination, so they race harmlessly and the loser's push simply fails. The claim is skipped when the lockup is funded below the quote's `to_amount`, and is safe to retry. Accepted swaps persist the pinned solver, relay set, RFQ id, amount, and versioned VHTLC reconstruction fields atomically with the settlement, so status polling and self-claim resume after restart.

**What triggers it.** Each quote registers its lockup as an SDK contract, so the contract manager pushes an event the moment the solver funds it and the claim goes out then — not on the next poll. That matters because the claim is what makes the solver settle the payer's hold invoice, so a claim held for an interval is a payer watching a spinner for it. `OFFLINE_POLL_INTERVAL_MS` remains the safety net under a subscription that dropped or never started, and one settlement pass runs at startup so a lockup funded while the process was down is claimed at boot. A lockup whose registration failed is claimed by that poller alone: it queries the indexer by script and needs no contract row.

### Per-payment destinations (`OFFLINE_COVENANT_DESTINATIONS`, default off)

The `arkade` rail hands the payer an address, and the server is not in the payment path — so with a single static address, two payments arriving at once are indistinguishable. Nothing on the wire says which is which, and the watcher is left correlating on amount and arrival window. Two payments of the same amount cannot be told apart at all.

With `OFFLINE_COVENANT_DESTINATIONS=true` each callback derives its own address instead, and the script becomes the identifier. A VTXO there belongs to exactly one record, so attribution is exact rather than inferred.

New addresses use a four-leaf Taproot script compiled from [`contracts/forwarding.ark`](contracts/forwarding.ark):

| leaf | who can spend | what it is for |
| --- | --- | --- |
| `condition(H(P))` + operator + covenant cosigner | anyone holding `P` | the sweep, pinned by the covenant |
| user + operator | the user, collaboratively | recovery without waiting |
| user alone, after a CSV delay | the user | recovery if the operator is gone |
| operator + renewal covenant cosigner | any batch participant | renew into the same script with all sats and assets preserved |

Only the first leaf carries `H(P)`, so a fresh preimage moves the address while the covenant bytes stay fixed. **The preimage is not a secret** — the covenant means whoever holds it can only pay the user's registered address — which is why the two recovery leaves are keyed to the user and need neither `P` nor this server.

A sweeper moves each funded destination on to the static address, so the user's wallet sees an ordinary arrival there and needs to know nothing about any of this. It costs one extra Arkade transaction per payment, and the rail gains a dependency on the emulator co-signing that sweep. If derivation fails at request time the callback falls back to the static address: that payment is ambiguous again, which beats refusing to be paid.

`OFFLINE_COVENANT_RECOVERY_DELAY_SECONDS` overrides the CSV delay on the third leaf. When unset, the server uses `unilateralExitDelay` from arkd's `/v1/info` response. The delay must be at least arkd's unilateral exit delay and a positive multiple of 512: BIP68 encodes seconds in 512s units, so 86400 — 24h exactly — is not a legal value and is refused at startup. Without an override or a usable arkd delay, startup is refused.

Expired or operator-swept v3 outputs are recovered through a batch before forwarding. The service keeps the original payment reference and persists the current covenant outpoint across renewals; a renewal commitment is never payout evidence. Already-unrolled outputs remain on the user's unilateral recovery path. Stored v1/v2 contracts retain their original scripts and addresses.

Renewal preserves the entire payment, so its batch fees require separate funding. On networks with nonzero intent fees, set `OFFLINE_COVENANT_RENEWAL_MNEMONIC` to a dedicated fee-payer wallet and fund the address printed at startup. Without it, positive-fee renewal fails visibly and retries; it never deducts fees from the user's payment. Zero-fee renewal needs no wallet key.

Run `pnpm artifact` to regenerate the digest-pinned compiler artifact. CI checks that regeneration leaves the committed JSON and TypeScript artifact unchanged.

## Payment options (LUD-XX)

Once an address has a registered Arkade identity (see above), its LUD-06 `payRequest` advertises multiple rails — and one that also registered a boarding address advertises `onchain` alongside them:

```json
"paymentOptions": [
  { "id": "lightning", "type": "lightning" },
  { "id": "arkade", "type": "arkade" },
  { "id": "onchain", "type": "onchain" }
]
```

A payer selects one with `?paymentOption=<id>` on the callback:

- **`lightning`** (or omitted) — the existing BOLT11 flow (live wallet, or an offline reverse swap). Returns `pr` + `verify`.
- **`arkade`** — returns an Arkade address to pay directly, no swap.
- **`onchain`** — returns the owner's Arkade boarding address, for an ordinary on-chain payment.

Both destination rails answer in the same shape:

```json
{ "status": "OK", "paymentOption": "arkade", "paymentDestination": "tark1..." }
```

**`verify` is present only when the destination identifies the payment**, which means only on the `arkade` rail with `OFFLINE_COVENANT_DESTINATIONS` enabled — that mints a fresh covenant address per payment:

```json
{ "status": "OK", "paymentOption": "arkade", "paymentDestination": "tark1...", "verify": "https://pay.example.com/lnurl/verify/<id>" }
```

Without it, one static address is reused for every payment and settlement is correlated by amount and arrival window, so two concurrent payments of the same size cannot be told apart — a payer polling `verify` could be told someone else's had arrived. The record is still written, the watcher still settles it, and it still appears in the owner's history; the payer is simply not handed a URL whose answer the server cannot stand behind. The `onchain` rail omits `verify` for a stronger reason: nothing here watches Bitcoin, so it could only ever answer "not settled".

Where it is present, the `verify` URL reports the non-`pr` LUD-21 shape: `{ status, settled, paymentOption, paymentDestination, paymentReference }`. Unknown or unavailable options return `{ "status": "ERROR", "reason": "Unsupported paymentOption" }`.

> The payer pays the destination **directly**, so settlement is observed, not reported. For the static Arkade address, a background watcher polls the Arkade indexer when `ARK_SERVER_URL` is set and flips `settled` (with `paymentReference` = the Arkade txid) once a payment covering the agreed amount arrives; correlation is by address + amount + arrival time, and that fuzziness is inherent to reference-less address payments. A covenant destination needs no correlation — the script belongs to exactly one record — and settles from a contract event instead. Addresses without an Arkade identity stay pure LUD-06 (no `paymentOptions`).

### Receive rails

Every backend is one entry in the rail registry (`src/rails.ts`): `interactive-lightning` (live wallet session), `offline-swap` (solver-mediated `bolt11->arkade-btc` while offline), `arkade` (direct destination), `covenant` (per-payment destinations for the arkade rail), `onchain` (the owner's boarding address — an ordinary on-chain payment, not a swap, which is why nothing here observes it), `fixedfloat` (token deposits, below), and `registered` (payment methods the owner registers on their address, each offered as a `registered:<type>` option and answered with its destination as given — the server never interprets a destination, nothing here observes or verifies a payment to one, and the type and destination are given to anyone who resolves the alias, a disclosure the receiver opts into). New rails — assets, an onchain-BTC-to-arkade-BTC offline receive in the same family as `offline-swap` — slot in there with no plumbing changes.

Server-wide capability comes from configuration; per-address policy comes from the operator. `GET /admin/api/rails` lists what this process wired, each address carries its own disabled set (stored in SQLite, edited in the admin UI Addresses tab under Rails, or via `PATCH /admin/api/addresses/{id}/rails`), and the payRequest advertises only the rails that survive both. A disabled or unavailable rail never fails silently: its callbacks answer `{ "status": "ERROR" }` naming the rail, while the process keeps serving the rest.

### Token deposits (FixedFloat, opt-in, mainnet only)

With `FIXEDFLOAT_API_KEY` and `FIXEDFLOAT_API_SECRET` set, an address with an Arkade identity also advertises one option per stablecoin network (`ff-usdtarbitrum`, `ff-usdcsol`, `ff-usdttrc`, …): `type` is the CAIP-2 namespace, `asset` the CAIP-19 id, `unit` a `units[]` code (`USDT`, `USDC`), `provider` the custodian. The payer deposits the token with FixedFloat, which pays the corridor's hold invoice, and the covenant pays arkade BTC to the receiver. The callback (`?amount=<msat>&paymentOption=ff-…`) answers the deposit address, an EIP-681 or Solana Pay `paymentURI` (none on Tron), and a `paymentQuote` whose `payment` is the deposit in the token's base units and whose `expiresAt` is the payer's deadline: the earlier of FixedFloat's own deadline and the corridor invoice's less `FIXEDFLOAT_SETTLE_MARGIN_SECONDS`, refused when that leaves under `FIXEDFLOAT_MIN_PAY_WINDOW_SECONDS`. `verify` answers the destination shape; once settled, `paymentReference` is the payer's deposit txid on the token chain.

**A deposit after the quote's `expiresAt` may not be paid out.** FixedFloat often keeps an order open longer than the corridor invoice allows; a payer who deposits after our deadline but inside FixedFloat's may find the invoice already dead, and FixedFloat then holds the tokens in its emergency/refund flow. The order poller keeps watching expired orders until the TTL so such a deposit is logged (`ff_order_emergency`) and shown in the admin Settlements view.

**The trust model, plainly.** While the swap is in flight the payer's tokens sit with **FixedFloat**, a no-KYC custodial exchange, and the sats sit in the **solver's** VHTLC. This server holds no user funds and no user keys, and it cannot compel either party to perform. The two legs are not equally trust-minimised: the last one is covenant-enforced (a settled swap can only pay the receiver's registered address), the first is ordinary exchange counterparty risk. **This server cannot refund a payer**: it never holds their tokens, has no address to return them to, and never drives FixedFloat's emergency flow. A late, short or over deposit lands the order in FixedFloat's `EMERGENCY` state, which the payer resolves with FixedFloat; the admin Settlements view shows it.

**Mainnet only.** FixedFloat has no testnet, so the server refuses to start with FixedFloat keys while arkd reports any network but `bitcoin`: a test deployment would take a payer's real tokens for test sats. `FIXEDFLOAT_SIMULATE=true` is the reverse — an in-process stand-in, refused on `bitcoin` and with real keys, that advertises `ffsim-` options with `provider: "Simulated"` on testnet chains so wallet and checkout UIs can be exercised end to end. It takes no deposit; a test that needs a settled order pays the corridor invoice itself.

FixedFloat allows 250 request-weight units a minute per key and an order costs 50, so the rail takes at most a handful of orders a minute. So that no single party can hold them all, the callback answers HTTP 429 past `FIXEDFLOAT_ORDERS_PER_IP` token callbacks from one IP, past `FIXEDFLOAT_MAX_OPEN_ORDERS_PER_ADDRESS` unfunded orders for one receiver, and past `FIXEDFLOAT_MAX_OPEN_ORDERS` in all. FixedFloat blocks a key that exceeds its limit, for longer each time, so after an HTTP 429 or five errors in a row every FixedFloat call pauses for two minutes and the options read `available: false`; two invoices FixedFloat cannot route (code 304) close one receiver's token callbacks for ten minutes. Token deposits need a file-backed `DB_PATH` and offline receive (the corridor is what pays the order).

## Payment quote (LUD-XX)

Optional: denominate amounts in units other than millisatoshis (USD, EUR, USDT, …). Set `QUOTE_UNITS` and each unit is priced from its own JSON price feed (`src/price-feed.ts`, the same feed contract intent-solver's asset markets use): one URL answering the unit's price per **one whole bitcoin**, and an RFC 6901 pointer to that price.

```bash
QUOTE_UNITS=USD,EUR
QUOTE_USD_FEED_URL=https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd   # pointer derived: /bitcoin/usd
QUOTE_USD_DECIMALS=2
QUOTE_EUR_FEED_URL=https://api.binance.com/api/v3/ticker/price?symbol=BTCEUR                      # pointer derived: /price
QUOTE_EUR_DECIMALS=2
```

With `DB_PATH` set, units can also be added, replaced and removed at runtime from the admin UI's **Quotes** tab or `/admin/api/quote-units`, with no restart. They are stored in SQLite. A unit saved there replaces the `QUOTE_UNITS` unit of the same code, and removing it brings the env one back; env units themselves can only be removed from the environment. Feed URLs entered there must answer before they are saved, and may not point at private, loopback or link-local hosts (env feeds may, for local stacks).

Feeds refresh in the background every `QUOTE_REFRESH_MS`; a quote never waits on one. A unit whose last good price is older than three refresh intervals is neither advertised nor quoted, and `/health` reports `priceFeeds` (optional, so it never fails readiness). Without `QUOTE_UNITS`, `units` is not advertised and any `unit=` request is rejected. Embedders of `createServer` can pass `priceFeedQuotes(...)` or any other `QuoteProvider` as `quoteProvider`.

When a provider is configured, both the LN-address and the session-LNURL `payRequest` advertise `units`:

```json
"units": [{ "code": "USD", "decimals": 2 }]
```

A payer denominates the callback with `?unit=<code>` (optionally `&receiveUnit=<code>`). `amount` is then the smallest integer of that unit (e.g. `amount=100&unit=USD` = $1.00). The provider quotes it to millisats — which drives the bolt11 / offline swap — and the response echoes the quote:

```json
{ "pr": "lnbc...", "routes": [], "paymentQuote": { "requested": { "amount": "100", "unit": "USD" }, "payment": { "amount": "162345000", "unit": "msat" } }, "verify": "..." }
```

An unknown or unsupported unit returns `{ "status": "ERROR", "reason": "Unsupported unit" }`. The receiver always gets sats, so `receiveUnit` may only be `msat`. The quote is rounded up to a whole sat, never down: the offline-swap corridor and wallets deal only in whole sats.

Each quoted payment records what was asked, so history can show it: the owner's `/lnurl/address/:handle/payments` rows and the admin Settlements view carry `quote: { amount, unit, decimals }` (amount in the unit's smallest denomination) beside `amountMsat`, and `null` for a payment made in sats.

> Quoting applies to the Lightning path (relay + offline swap) and the `arkade`/`onchain` destination rails; token-deposit rails reject `unit`, since they quote their own payment. No spread is added: the payer pays the feed's mid price.

### Receive amount

A unit fixes what the payer pays. To fix what the receiver nets instead, the payer adds `receiveAmount` (millisats of whole sats), and `amount` becomes the most it will pay:

```http
GET /.well-known/lnurlp/alice/callback?amount=1100000&receiveAmount=1000000
```

Only the offline swap can price this, so a payRequest offers it as `"receiveAmountAllowed": true` while that rail can serve the address: a static Arkade identity, the rail enabled, discovery ready. It takes the offline swap even while the owner's wallet is connected, and is refused with `unit`, `receiveUnit` or a non-lightning `paymentOption`. The solver's fee rides on top, and the answer splits the invoice:

```json
{ "pr": "lnbc...", "routes": [], "verify": "...", "verifyBatch": "...", "paymentQuote": { "requested": { "amount": "1000000", "unit": "msat" }, "payment": { "amount": "1053000", "unit": "msat" }, "receive": { "amount": "1000000", "unit": "msat" }, "fees": [{ "name": "solver", "amount": { "amount": "53000", "unit": "msat" } }] } }
```

Pay only an invoice for exactly `paymentQuote.payment`, no more than `amount`, whose `receive` is what you asked for. A server that does not know `receiveAmount` ignores it and invoices plain `amount` with no `receive`: stop there. The client's `requestInvoice({ amountSat, receiveAmountSat })` makes these checks. History records the invoice amount, as for any offline-swap receive. A unified BIP21 can carry the receive amount as its `amount` and this invoice as its `lightning` leg.

## Admin backend — port 3001

When `DB_PATH` is set an admin backend starts on `ADMIN_PORT` (default `3001`), bound to `ADMIN_BIND` (default `127.0.0.1` for the CLI).

**The admin API has no built-in authentication.** Front it with Cloudflare Access, an nginx `auth_basic` block, or another authentication proxy. Do **not** publish port 3001 (`-p 3001:3001`) to the internet without a front proxy.

The Docker image binds to `0.0.0.0` so isolation happens at the container/proxy boundary.

### Admin API (`/admin/api/*`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/api/domains` | List domains |
| POST | `/admin/api/domains` | Create domain |
| PATCH | `/admin/api/domains/:id` | Update domain |
| DELETE | `/admin/api/domains/:id` | Delete domain |
| GET | `/admin/api/addresses` | List addresses newest first, one page at a time: `{ addresses, nextCursor }` (filter: `domainId`, `status`, `q`; `limit` defaults to 200, at most 1000; pass `nextCursor` back as `cursor`, absent on the last page) |
| GET | `/admin/api/addresses/count` | Count every address: `{ count }` |
| POST | `/admin/api/addresses` | Reserve or mint an address |
| POST | `/admin/api/addresses/:id/claim-code` | Reissue a reserved address's claim code, shown once; the old code stops working (409 once claimed) |
| GET | `/admin/api/claim-codes` | List free-name claim codes, never the codes themselves (filter: `domainId`) |
| POST | `/admin/api/claim-codes` | Issue a free-name claim code for `{ domain }`, shown once |
| DELETE | `/admin/api/claim-codes/:id` | Revoke an unspent claim code; a spent one is kept as the record of what it claimed (409) |
| POST | `/admin/api/claim-codes/:id/reissue` | Reissue an unspent claim code, shown once; the old code stops working (409 once spent) |
| PATCH | `/admin/api/addresses/:id` | Update address status (`active`/`revoked`) |
| DELETE | `/admin/api/addresses/:id` | Delete address |
| GET | `/admin/api/api-keys` | List API keys |
| POST | `/admin/api/api-keys` | Create API key |
| DELETE | `/admin/api/api-keys/:id` | Revoke API key |
| GET | `/admin/api/blacklist` | List blacklist entries |
| POST | `/admin/api/blacklist` | Add blacklist entry |
| DELETE | `/admin/api/blacklist/:id` | Remove blacklist entry |
| GET | `/admin/api/sessions` | List active session IDs |
| GET | `/admin/api/settlements` | List settlement records (filter: `settled`, `option`, `limit`) — preimages/pr never exposed |
| GET/POST | `/admin/api/solver-cards` | List or paste a manual solver card |
| PUT/PATCH/DELETE | `/admin/api/solver-cards/:id` | Replace, enable/disable, or delete a card |
| GET | `/admin/api/discovery` | Inspect active candidates, sources, cache use, and warnings |
| POST | `/admin/api/discovery/refresh` | Refresh discovery immediately |
| GET | `/admin/api/quote-units` | List [quote units](#payment-quote-lud-xx) with their live price, freshness and last error |
| PUT/DELETE | `/admin/api/quote-units/:code` | Add or replace a unit (`{ decimals, feedUrl, pricePath? }`; the feed is read first and a dead one refused), or remove one |
| POST | `/admin/api/quote-units/preview` | Read a feed once without saving it |
| POST | `/admin/api/quote-units/refresh` | Re-read every feed now |

The admin port also serves a React SPA at `/` (the `lnurl-admin` UI).

### Reserve vs mint

- **Reserve** — creates a `reserved` address with a one-time `claimCode`. Share the code with the wallet owner; the wallet sends it in a `POST /lnurl/address` request, alone or with the username, to claim and activate the address.
- **Free-name claim code** — `POST /admin/api/claim-codes` issues a one-time code that reserves no name. Its holder sends it with any available username, which works on a domain without `"self"` mode too.
- **Mint** — creates an `active` address pre-bound to a `secret` (the wallet token). The wallet can immediately use the address without claiming.

A holder who lost a code gets a reissued one: the reservation or free-name code keeps its place, the new code is shown once, and the old one stops working.

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `3000` | Public server port |
| `BASE_URL` | `http://localhost:3000` | Public URL for generating LNURLs |
| `MIN_SENDABLE` | `1000` | Minimum sendable amount in millisats |
| `ONCHAIN_MIN_SENDABLE_SATS` | `10000` | Economic floor for the onchain option, sats. arkd's dust (330) is what it will *accept*, not what is worth accepting: delivering an onchain payment costs the payer a Bitcoin transaction fee this server cannot see, so a dust-sized minimum invites payments that cost more to make than they deliver. Never lowers the rail below dust. |
| `MAX_SENDABLE` | `100000000000` | Maximum sendable amount in millisats |
| `INVOICE_TIMEOUT_MS` | `30000` | How long to wait (ms) for the wallet to provide a bolt11 |
| `VERIFY_TTL_MS` | `86400000` | How long (ms) a **bolt11** record stays readable by `verify`. Past it the invoice is dead, so the record is hidden — and reclaimed only if no address owns it. A record belonging to a registered address is that owner's history and is kept for `listPayments`. |
| `DESTINATION_WATCH_MS` | `604800000` | How long (ms) a handed-out **destination** stays watched, verifiable and settleable. Separate from `VERIFY_TTL_MS` because an invoice expires and a destination does not: the callback advertises no expiry, so a payer may pay one long after it was issued. Raising it only widens the window in which such a payment is still observed. |
| `SOLVER_REGISTRY_URLS` | published network index | Optional comma-separated solver-registry index URL override. Leave unset to follow the network default; set it empty to disable registries. Successful bodies are cached for up to seven days. |
| `SOLVER_CARDS_FILE` | — | Startup JSON file containing an array of manually pinned cards. Cards can also be pasted into the admin UI and persisted in SQLite. |
| `SOLVER_RFQ_HTTP_URL` | — | Routes RFQs to a solver's HTTP ingress (`POST /v1/swap`) instead of over nostr. A solver running `serve` answers HTTP and never subscribes to a relay, so without this there is no way to quote against one — which is how a local stack is driven. Unset, solvers are reached over nostr using the relays on their own card, which is what a deployed one listens on. |
| `NOSTR_SECRET_KEY` | — | 32-byte hex Nostr identity for the RFQ transport; ephemeral per boot when unset. **Key material** — treat it like a private key; prefer the ephemeral default unless a stable identity is genuinely required. |
| `COVCLAIMD_URL` | — | covclaimd daemon base URL (non-interactive VHTLC claims). When set, must be the same instance the solver reveals to — see the warning under [Offline receive](#offline-receive-opt-in). May be omitted with `OFFLINE_SELF_CLAIM=true` + `OFFLINE_EMULATOR_URL` (RFQ omits the claim packet). |
| `ARK_SERVER_URL` | — | Arkade operator URL (e.g. `https://mutinynet.arkade.sh`) — signer key, exit delay and network are read from it. |
| `OFFLINE_STAMP_CLAIM_PACKET` | `false` | `true` sends the claim packet for the solver to stamp into the funding tx, naming our covclaimd in-band — which removes the pairing requirement above entirely. **Only set it if the solver you quote carries [arkade-os/intent-solver#47](https://github.com/arkade-os/intent-solver/pull/47).** An older solver forwards the packet to its own covclaimd as a ciphertext, cannot decrypt it, and the swap funds and refunds. |
| `OFFLINE_SELF_CLAIM` | on with `OFFLINE_EMULATOR_URL` | Pushes each lockup's `nonInteractiveClaim` leaf here, alongside covclaimd when it is configured. On by default wherever an emulator is set, because covclaimd cannot claim this covenant today and a covclaimd-only deployment therefore claims nothing. Set `false` for a deliberate covclaimd-only rail. Needs no key — the leaf is signed by the operator and the emulator, and gated on the preimage this server already holds. Requires `OFFLINE_EMULATOR_URL`; `COVCLAIMD_URL` may be omitted. See [Self-claim](#self-claim-offline_self_claim). |
| `OFFLINE_EMULATOR_URL` | — | Emulator base URL backing `OFFLINE_SELF_CLAIM` and `OFFLINE_COVENANT_DESTINATIONS` — it co-signs the covenant leaf after checking the spend pays the user. With `COVCLAIMD_URL` set, must be the emulator whose `emulator_pub_key` it reports; without it, must be the solver's emulator. Missing with either flag on, the server refuses to start. |
| `OFFLINE_COVENANT_DESTINATIONS` | `false` | `true` gives each arkade-rail payment its own covenant address, so concurrent payments are told apart by script instead of by amount and arrival window. Requires `OFFLINE_EMULATOR_URL` and `ARK_SERVER_URL` (`COVCLAIMD_URL` optional — only needed alongside the lightning offline swap). See [Per-payment destinations](#per-payment-destinations-offline_covenant_destinations-default-off). |
| `OFFLINE_COVENANT_RECOVERY_DELAY_SECONDS` | arkd's `unilateralExitDelay` | CSV delay before the user may sweep a covenant destination alone. An explicit override must be a positive multiple of 512 and at least arkd's delay. |
| `OFFLINE_COVENANT_RENEWAL_MNEMONIC` | — | Optional dedicated wallet paying v3 renewal batch fees. Requires covenant destinations; fund its startup address with BTC. The payment's sats and assets are preserved in full. |
| `OFFLINE_POLL_INTERVAL_MS` | `15000` | Offline settlement pass interval, and the covenant watcher's catch-up cadence. Neither is what normally settles a payment — a funding event does — so what is left on both is the backstop for a dropped subscription, plus the solver status check the RFQ transport cannot push. The covenant half matters because that subscription does drop in normal operation: an event lost to a reconnect window is only recovered by the next catch-up pass. Lower it to see settlement sooner, at the cost of solver requests. |
| `DB_PATH` | — | Path to SQLite database file. Omit for in-memory-only mode. |
| `TOKEN_ENCRYPTION_KEY` | — | 32-byte AES key (hex or base64). Required with `DB_PATH` unless the insecure fallback is explicitly allowed. |
| `ALLOW_INSECURE_TOKEN_STORAGE` | — | Set to `1` to use the source-known fallback key and accept that database token confidentiality is not provided. |
| `ADMIN_PORT` | `3001` | Admin backend port |
| `ADMIN_BIND` | `127.0.0.1` | Admin bind address (`0.0.0.0` in Docker) |
| `BOOTSTRAP_DOMAIN` | — | Domain name to create on first startup if no domains exist |
| `REGISTRATION_RATE_LIMIT` | `10` | Max address registration requests per minute per IP |
| `CALLBACK_RATE_LIMIT_PER_MINUTE` | `30` | Max Lightning-address callbacks per minute per client IP on the branches that cost the server without a live wallet session — an offline-swap quote or a destination. One budget, shared by both. |
| `TRUST_PROXY` | `1` | Express `trust proxy` value — number of hops or `false` |
| `TRUSTED_FORWARDERS` | — | Comma-separated IPs and CIDRs (IPv4 or IPv6) whose `X-Forwarded-For` is believed at any hop, on top of the `TRUST_PROXY` hops. For a server that calls callbacks for its payers, such as BTCPay Server: it forwards each payer's IP, so per-IP limits apply per payer rather than to all of its checkouts at once. **Only list hosts you control or trust: a trusted forwarder decides which IP each of its requests is limited as.** Anyone else's `X-Forwarded-For` is ignored as before. The reverse proxy in front must append to the forwarder's header rather than replace it; many proxies replace it by default for clients they don't trust. With `TRUST_PROXY=false`, a listed forwarder that connects directly also has its `X-Forwarded-Proto` believed, which sets the scheme of the URLs in its own responses. |
| `TRACE_REQUESTS` | — | Set to `1` to log one structured line per request — method, path, `Host`, status, duration, request id, and the `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Real-Ip` headers — on both the public and admin servers, plus the resolved startup config. Unmatched 404s are logged too, so no line at all means the request never reached the process. Off by default. |
| `MAX_SESSIONS` | `5000` | Global concurrent SSE session cap |
| `MAX_SESSIONS_PER_IP` | `50` | Concurrent SSE session cap per resolved client IP |
| `MAX_CONCURRENT_OFFLINE_QUOTES` | `20` | Global in-flight offline RFQ cap |
| `FIXEDFLOAT_API_KEY` / `FIXEDFLOAT_API_SECRET` | — | Turn on [token deposits](#token-deposits-fixedfloat-opt-in-mainnet-only); both or neither. Mainnet (`bitcoin`) only — the server refuses to start with them elsewhere. **Credentials**: the secret signs every request and is held only by the signer. |
| `FIXEDFLOAT_ALLOW` / `FIXEDFLOAT_DENY` | all / none | Comma-separated FixedFloat codes to offer, from the 13 stablecoin networks whose decimals the server knows (`src/rails/fixedfloat/catalogue.ts`); deny applies after allow. |
| `FIXEDFLOAT_SETTLE_MARGIN_SECONDS` | `600` | What FixedFloat may need between a deposit and paying the invoice: the payer's deadline ends this long before the corridor invoice's. |
| `FIXEDFLOAT_MIN_PAY_WINDOW_SECONDS` | `300` | The shortest deadline a payer is handed. Checked before an order is created (invoice less margin) and after (the earlier of that and FixedFloat's deadline); less, and the callback refuses. |
| `FIXEDFLOAT_MAX_OPEN_ORDERS` | `20` | Unfunded, unexpired orders allowed at once. |
| `FIXEDFLOAT_MAX_OPEN_ORDERS_PER_ADDRESS` | `5` | Unfunded, unexpired orders one receiving address may have at once. |
| `FIXEDFLOAT_ORDERS_PER_IP` / `FIXEDFLOAT_ORDERS_PER_IP_WINDOW_SECONDS` | `10` / `600` | Token callbacks one IP may make per window. A BTCPay server is one IP for all its checkouts, so raise this for a busy one. Before this limit applies, each token callback also spends one of the 30 callbacks a minute per IP that the offline Lightning and Arkade destination callbacks share. That limit is fixed in code, with no setting: a burst of token callbacks can refuse the same server's other callbacks for the rest of that minute, and a rate here above 30 a minute has no effect. |
| `FIXEDFLOAT_REFRESH_MS` | `300000` | Rates and currency-list refresh interval. |
| `FIXEDFLOAT_BASE_URL` / `FIXEDFLOAT_RATES_URL` | `https://ff.io/api/v2` / `https://ff.io/rates/fixed.xml` | FixedFloat's API and public rates export. |
| `FIXEDFLOAT_SIMULATE` | `false` | `true` runs the simulated provider instead; never on `bitcoin`, never with keys. |
| `QUOTE_UNITS` | — | Comma-separated unit codes to quote ([Payment quote](#payment-quote-lud-xx)). Each needs the three settings below. With `DB_PATH`, more can be added at runtime in the admin UI. |
| `QUOTE_<CODE>_FEED_URL` | — | JSON price feed answering the unit's price per one whole bitcoin. |
| `QUOTE_<CODE>_DECIMALS` | — | Decimals of the unit's smallest denomination (`2` for USD cents, `6` for USDT). Required: a wrong guess misprices by a power of ten. |
| `QUOTE_<CODE>_PRICE_PATH` | derived for Binance / single-currency CoinGecko URLs | RFC 6901 pointer to the price in the feed's response, e.g. `/data/0/price`. |
| `QUOTE_REFRESH_MS` | `60000` | Feed refresh interval; a price older than three intervals stops being quoted. |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Grace period before lingering HTTP connections are forced closed |

## Development

```bash
pnpm install
pnpm dev         # start with hot reload
pnpm build       # build for production
pnpm type-check  # typecheck without emitting
```

### Test layers

Four suites, each answering a question the one below it cannot. A green unit run
says nothing about a browser, and a green browser run against a mock says nothing
about a solver — so the funded paths are proved against a real stack.

```bash
pnpm test               # unit + integration, real HTTP servers, no mocks (Node 22+ for node:sqlite)
pnpm test:e2e           # funded offline receive and restart recovery, against a local Arkade stack
pnpm test:browser:local # the wallet in Chromium, driving every rail against that same local stack
pnpm test:browser       # the wallet in Chromium against the live mutinynet deployment
```

`pnpm test:e2e` and `pnpm test:browser:local` raise the Arkade regtest stack
themselves from the `regtest` submodule (`git submodule update --init`), pull the
solver image pinned in `test/e2e/support/regtest.ts`, and need Docker. The first
boot pulls a lot of images and takes a while; later runs reuse a healthy stack.

`pnpm test:browser:local` is the one that covers the feature matrix end to end —
every receive rail including a real Lightning payment from the stack's own node,
the send paths, the admin UI, and the wallet's own surface. Reaching the stack's
solver from a browser needs two things it does not provide, both supplied by the
preview server: it sends no CORS headers, so `/solver` is proxied same-origin, and
its card is in no published registry, so one is served from that card.

`pnpm test:browser` hits the live deployment and so costs real sats. The specs
tagged `@funded` and `@provision` are skipped in CI for that reason and need a
wallet provisioned and topped up by hand:

```bash
pnpm --filter @arkade-os/lnurl-demo-wallet exec playwright test --grep @provision
# fund the addresses it prints, then:
pnpm test:browser
```
