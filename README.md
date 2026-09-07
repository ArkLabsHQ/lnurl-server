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
| DELETE | `/lnurl/address/:username` | Wallet | Revoke own address (`Authorization: Bearer <token>`) |
| POST | `/lnurl/address/:username/arkade` | Wallet | Register Arkade receive identity for offline receive (`Authorization: Bearer <token>`) |

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

The admin port (3001) is **not** published in the example above. See [Admin backend](#admin-backend--port-3001) for how to expose it safely.

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

When `DB_PATH` is set, `TOKEN_ENCRYPTION_KEY` is **required**. Wallet session tokens are stored encrypted (AES-256-GCM) so a database dump cannot be used to impersonate wallets.

- `TOKEN_ENCRYPTION_KEY` — 32-byte secret, encoded as hex (64 chars) or base64 (44 chars).  
  Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `ALLOW_INSECURE_TOKEN_STORAGE=1` — **dev only** escape hatch that stores tokens in plaintext without requiring `TOKEN_ENCRYPTION_KEY`. Do not use in production.

## LN Address (LUD-16)

When persistence is enabled the service can serve Lightning addresses (`user@domain.com`). Resolution is host-based: the `Host` header of the incoming request selects the domain. Multi-domain setups are supported by routing different hostnames to the same server instance.

- **Online** — `/.well-known/lnurlp/:username` returns pay metadata and the callback triggers an invoice request to the wallet's live SSE session.
- **Offline** — if the wallet's SSE session is not active the callback returns an LNURL error (`status: "ERROR"`).

### Address provisioning

Wallets register a Lightning address via `POST /lnurl/address`. The request body must include a `token` (the wallet's session token). The `username` and `domain` fields determine which address is assigned:

| Request | Behaviour |
|---------|-----------|
| `username` provided, domain allows `"self"` mode | Wallet claims that specific username |
| no `username`, domain allows `"random"` mode | Server assigns a random username |
| `username` + `claimCode` provided | Wallet claims a pre-reserved address |

Constraints enforced per domain:
- **`allocationModes`** — which of `"self"`, `"random"`, `"admin"` the domain permits.
- **`requireApiKey`** — if true, requests must include a valid `X-API-Key` header.
- **`max_per_session`** — cap on active addresses per wallet session.
- **`username_min_len` / `username_max_len` / `username_pattern`** — username validation rules.
- **Blacklist** — per-domain and global username blacklist enforced at registration time.
- **Registration rate limit** — per-IP limit controlled by `REGISTRATION_RATE_LIMIT` (requests/min per IP).

## Offline receive (opt-in)

Normally an LN address only resolves while the wallet's SSE session is connected. With offline receive, a wallet can receive while disconnected: the server quotes a **solver-mediated swap over the Arkade intents corridor** (`lightning:BTC -> arkade:BTC`) and hands the payer the solver's hold invoice. When the payer pays, the solver funds a VHTLC pinned to the user's Arkade address, and a **covclaimd** daemon claims it on the user's behalf — constrained by covenant (`enforcePayTo`) to pay only that address, so neither the solver nor the daemon can redirect funds.

Enable it by setting a solver transport — `SOLVER_REGISTRY_URL` (discover the cheapest lightning-corridor solver from a [registry index](https://arkade-os.github.io/solver-registry/), e.g. `…/mutinynet.json`), or `SOLVER_PUBKEY` + `NOSTR_RELAYS` (pin a solver directly), or `SOLVER_URL` (HTTP, dev/custom solvers) — plus `COVCLAIMD_URL` and `ARK_SERVER_URL`. A wallet then registers its receive identity on an owned address:

> **`COVCLAIMD_URL` must name the same covclaimd instance the solver reveals to.** The protocol does not carry that choice: this server seals the preimage to the key its own `COVCLAIMD_URL` reports, while the solver reveals to whichever daemon *its* operator configured. Point them at different daemons and every offline receive funds, fails to claim, and refunds — covclaimd correctly refuses a packet it cannot decrypt, the solver retries that refusal until the refund deadline, and the only trace is in the solver operator's logs, not yours. Until [arkade-os/intent-solver#46](https://github.com/arkade-os/intent-solver/issues/46) moves the choice in band, confirm the pairing with whoever runs the solver.

```bash
curl -X POST https://pay.example.com/lnurl/address/alice/arkade \
  -H "Authorization: Bearer <session-token>" \
  -H "Content-Type: application/json" \
  -d '{"arkadeAddress":"tark1...","claimPublicKey":"02..."}'
```

After that, if a payer pays `alice@pay.example.com` while the wallet is offline, the server returns the solver's hold invoice and reports settlement through the LUD-21 `verify` URL (polled from the solver's RFQ status). The server never holds the user's keys or funds — it generates the swap preimage and hands it to covclaimd encrypted (sealed into the quote request, so it never touches the solver in plaintext).

> The corridor client is vendored at `src/vendor/arkade-swap/` (byte-exact from `arkade-os/ts-sdk` — see its README for the exit plan) until `@arkade-os/swap` ships a release carrying the receive corridors. The wire contract is integration-tested against fake HTTP services and was **live-probed against the public mutinynet solver** (`scripts/probe-solver.ts`) — quote, hold-invoice binding, and covenant derivation all verified. A full funded swap (payer pays, covclaimd claims) remains the operator's pre-production check.

### Self-claim (`OFFLINE_SELF_CLAIM`, default off)

Normally covclaimd is the only thing that claims the solver's lockup, and it needs the sealed claim packet because it does not have the preimage. This server *does* — it generates it. With `OFFLINE_SELF_CLAIM=true` and `OFFLINE_EMULATOR_URL` set, the server pushes the same claim itself, so covclaimd is no longer the single point of failure.

**Which leaf, and what pins the destination.** It spends the covenant's `nonInteractiveClaim` leaf — the same one covclaimd uses. That leaf is `preimage + Arkade operator + an emulator key tweaked by `enforcePayTo(receiverPkScript)``, where `receiverPkScript` is the user's registered Arkade address. Two things follow, and they are different claims:

- **This server cannot redirect the payout.** The leaf requires signatures from the Arkade operator and the emulator, and this server holds neither key. That follows from the tapscript alone.
- **No pusher can redirect it either** — but that one rests on the emulator, which derives its per-covenant key from `enforcePayTo(...)` and, by policy, signs only after checking the spend satisfies it. That check is what makes "anyone can push this leaf" safe by design.

**No key, and nothing taken from the user.** The server needs no key of its own, so there is no new secret to hold or rotate. The user keeps their `claimPublicKey` in the covenant's `receiver` role and with it the collaborative `claim` and `unilateralClaim` leaves, exactly as with the flag off. This is an additional pusher, not a transfer of control. The server still holds the preimage — it always did — so enabling this adds no custody it did not already have.

> The collaborative `claim` leaf is deliberately **not** used. It is a bare `preimage + receiver + operator` multisig with no output constraint, so a server holding the receiver key and the preimage could send a funded lockup anywhere. Spending it would make this server custodial for every in-flight swap.

> **`OFFLINE_EMULATOR_URL` must name the emulator whose key is baked into the covenant.** That key comes from `COVCLAIMD_URL`'s `emulator_pub_key`, so the two must agree — point them at different emulators and every push is refused, the same pairing hazard as `COVCLAIMD_URL` itself. Startup checks this and logs a warning naming both keys if they disagree; it never refuses to start, and it stays silent when either service is unreachable, so a boot-time blip is not mistaken for a misconfiguration. An emulator that has rotated its key still counts as a match, since covenants built under the retired key remain satisfiable.

covclaimd stays configured and keeps working alongside this: both push the same leaf to the same destination, so they race harmlessly and the loser's push simply fails. The claim fires from the offline settlement poller once the indexer shows a spendable VTXO at the lockup, is skipped when the lockup is funded below the quote's `to_amount` (revealing the preimage for less would let the solver settle the payer's invoice in full), and is safe to retry: an already-spent lockup is a no-op. Claim registrations live in memory, so swaps quoted before a restart fall back to covclaimd.

### Per-payment destinations (`OFFLINE_COVENANT_DESTINATIONS`, default off)

The `arkade` rail hands the payer an address, and the server is not in the payment path — so with a single static address, two payments arriving at once are indistinguishable. Nothing on the wire says which is which, and the watcher is left correlating on amount and arrival window. Two payments of the same amount cannot be told apart at all.

With `OFFLINE_COVENANT_DESTINATIONS=true` each callback derives its own address instead, and the script becomes the identifier. A VTXO there belongs to exactly one record, so attribution is exact rather than inferred.

The address is a three-leaf Taproot script:

| leaf | who can spend | what it is for |
| --- | --- | --- |
| `condition(H(P))` + operator + covenant cosigner | anyone holding `P` | the sweep, pinned by the covenant |
| user + operator | the user, collaboratively | recovery without waiting |
| user alone, after a CSV delay | the user | recovery if the operator is gone |

Only the first leaf carries `H(P)`, so a fresh preimage moves the address while the covenant bytes stay fixed. **The preimage is not a secret** — the covenant means whoever holds it can only pay the user's registered address — which is why the two recovery leaves are keyed to the user and need neither `P` nor this server.

A sweeper moves each funded destination on to the static address, so the user's wallet sees an ordinary arrival there and needs to know nothing about any of this. It costs one extra Arkade transaction per payment, and the rail gains a dependency on the emulator co-signing that sweep. If derivation fails at request time the callback falls back to the static address: that payment is ambiguous again, which beats refusing to be paid.

`OFFLINE_COVENANT_RECOVERY_DELAY_SECONDS` (default 86528) sets the CSV delay on the third leaf. It must be a multiple of 512: BIP68 encodes seconds in 512s units and rejects anything else, so 86400 — 24h exactly — is not a legal value and is refused at startup.

## Payment options (LUD-XX)

Once an address has a registered Arkade identity (see above), its LUD-06 `payRequest` advertises multiple rails:

```json
"paymentOptions": [{ "id": "lightning", "type": "lightning" }, { "id": "arkade", "type": "arkade" }]
```

A payer selects one with `?paymentOption=<id>` on the callback:

- **`lightning`** (or omitted) — the existing BOLT11 flow (live wallet, or an offline reverse swap). Returns `pr` + `verify`.
- **`arkade`** — returns the user's Arkade address directly, for on-Arkade payment (no swap):

```json
{ "status": "OK", "paymentOption": "arkade", "paymentDestination": "tark1...", "verify": "https://pay.example.com/lnurl/verify/<id>" }
```

The `verify` URL then reports the non-`pr` LUD-21 shape: `{ status, settled, paymentOption, paymentDestination, paymentReference }`. Unknown or unavailable options return `{ "status": "ERROR", "reason": "Unsupported paymentOption" }`.

> The payer pays the Arkade address **directly**, so settlement is observed, not reported: when `ARK_SERVER_URL` is set, a background watcher polls the Arkade indexer and flips `settled` (with `paymentReference` = the Arkade txid) once a payment covering the agreed amount arrives at the destination. Correlation is by address + amount + arrival time — an unrelated same-amount payment in the same window can flip a record; that fuzziness is inherent to reference-less address payments. Addresses without an Arkade identity stay pure LUD-06 (no `paymentOptions`). New rails/assets are added in `src/payment-options.ts`.

## Payment quote (LUD-XX)

Optional: denominate amounts in units other than millisatoshis (USD, USDT, …). This server has **no rate oracle**, so quoting is delegated to an injected `QuoteProvider` (`src/quote-provider.ts`). Without one, `units` is not advertised and any `unit=` request is rejected.

When a provider is configured, the LN-address `payRequest` advertises `units`:

```json
"units": [{ "code": "USD", "name": "US Dollar", "symbol": "$", "decimals": 2 }]
```

A payer denominates the callback with `?unit=<code>` (optionally `&receiveUnit=<code>`). `amount` is then the smallest integer of that unit (e.g. `amount=100&unit=USD` = $1.00). The provider quotes it to millisats — which drives the bolt11 / offline swap — and the response echoes the quote:

```json
{ "pr": "lnbc...", "routes": [], "paymentQuote": { "requested": { "amount": "100", "unit": "USD" }, "payment": { "amount": "162345000", "unit": "msat" } }, "verify": "..." }
```

An unknown or unsupported unit returns `{ "status": "ERROR", "reason": "Unsupported unit" }`.

> Framework only — plug real rates, assets, and swap-backed quotes in behind `QuoteProvider`. Quoting applies to the amount-denominated Lightning path (relay + offline swap); the `arkade` destination rail rejects `unit` for now.

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
| GET | `/admin/api/addresses` | List addresses (filter: `domainId`, `status`, `q`) |
| POST | `/admin/api/addresses` | Reserve or mint an address |
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

The admin port also serves a React SPA at `/` (the `lnurl-admin` UI).

### Reserve vs mint

- **Reserve** — creates a `reserved` address with a one-time `claimCode`. Share the code with the wallet owner; the wallet uses it in a `POST /lnurl/address` request to claim and activate the address.
- **Mint** — creates an `active` address pre-bound to a `secret` (the wallet token). The wallet can immediately use the address without claiming.

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `3000` | Public server port |
| `BASE_URL` | `http://localhost:3000` | Public URL for generating LNURLs |
| `MIN_SENDABLE` | `1000` | Minimum sendable amount in millisats |
| `MAX_SENDABLE` | `100000000000` | Maximum sendable amount in millisats |
| `INVOICE_TIMEOUT_MS` | `30000` | How long to wait (ms) for the wallet to provide a bolt11 |
| `VERIFY_TTL_MS` | `86400000` | How long (ms) LUD-21 settlement records are retained for `verify` polling |
| `SOLVER_URL` | — | Intent-solver RFQ HTTP base URL (dev/custom solvers). Alternatively configure the Nostr transport below. |
| `SOLVER_REGISTRY_URL` | — | Solver-registry index URL — discover the cheapest lightning-corridor solver (bounds from its card are enforced before quoting). The card is read at startup; a solver changing its bounds takes effect on restart. Alternative to pinning `SOLVER_PUBKEY`. |
| `SOLVER_PUBKEY` | — | Solver's x-only discovery pubkey (hex) for Nostr RFQ — the production transport. Needs `NOSTR_RELAYS`. |
| `NOSTR_RELAYS` | — | Comma-separated `wss://` relay URLs the solver listens on. |
| `NOSTR_SECRET_KEY` | — | 32-byte hex Nostr identity for the RFQ transport; ephemeral per boot when unset. **Key material** — treat it like a private key; prefer the ephemeral default unless a stable identity is genuinely required. |
| `COVCLAIMD_URL` | — | covclaimd daemon base URL (non-interactive VHTLC claims). Must be the same instance the solver reveals to — see the warning under [Offline receive](#offline-receive-opt-in). |
| `ARK_SERVER_URL` | — | Arkade operator URL (e.g. `https://mutinynet.arkade.sh`) — signer key, exit delay and network are read from it. |
| `OFFLINE_STAMP_CLAIM_PACKET` | `false` | `true` sends the claim packet for the solver to stamp into the funding tx, naming our covclaimd in-band — which removes the pairing requirement above entirely. **Only set it if the solver you quote carries [arkade-os/intent-solver#47](https://github.com/arkade-os/intent-solver/pull/47).** An older solver forwards the packet to its own covclaimd as a ciphertext, cannot decrypt it, and the swap funds and refunds. |
| `OFFLINE_SELF_CLAIM` | `false` | `true` pushes each lockup's `nonInteractiveClaim` leaf here as well as covclaimd, so covclaimd stops being a single point of failure. Needs no key — the leaf is signed by the operator and the emulator, and gated on the preimage this server already holds. Requires `OFFLINE_EMULATOR_URL`. See [Self-claim](#self-claim-offline_self_claim-default-off). |
| `OFFLINE_EMULATOR_URL` | — | Emulator base URL backing `OFFLINE_SELF_CLAIM` and `OFFLINE_COVENANT_DESTINATIONS` — it co-signs the covenant leaf after checking the spend pays the user. Must be the emulator whose `emulator_pub_key` `COVCLAIMD_URL` reports. Missing with either flag on, the server refuses to start. |
| `OFFLINE_COVENANT_DESTINATIONS` | `false` | `true` gives each arkade-rail payment its own covenant address, so concurrent payments are told apart by script instead of by amount and arrival window. Requires `OFFLINE_EMULATOR_URL`, `COVCLAIMD_URL` and `ARK_SERVER_URL`. See [Per-payment destinations](#per-payment-destinations-offline_covenant_destinations-default-off). |
| `OFFLINE_COVENANT_RECOVERY_DELAY_SECONDS` | `86528` | CSV delay before the user may sweep a covenant destination alone. |
| `DB_PATH` | — | Path to SQLite database file. Omit for in-memory-only mode. |
| `TOKEN_ENCRYPTION_KEY` | — | 32-byte AES key (hex or base64). Required when `DB_PATH` is set. |
| `ALLOW_INSECURE_TOKEN_STORAGE` | — | Set to `1` to skip token encryption in dev (plaintext storage). |
| `ADMIN_PORT` | `3001` | Admin backend port |
| `ADMIN_BIND` | `127.0.0.1` | Admin bind address (`0.0.0.0` in Docker) |
| `BOOTSTRAP_DOMAIN` | — | Domain name to create on first startup if no domains exist |
| `REGISTRATION_RATE_LIMIT` | `10` | Max address registration requests per minute per IP |
| `TRUST_PROXY` | `1` | Express `trust proxy` value — number of hops or `false` |

## Development

```bash
pnpm install
pnpm test        # run tests (requires Node 22+ for node:sqlite)
pnpm dev         # start with hot reload
pnpm build       # build for production
pnpm type-check  # typecheck without emitting
```
