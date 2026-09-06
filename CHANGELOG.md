# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added
- **Self-claim (`OFFLINE_SELF_CLAIM`, default off)** — the server can now push the solver-funded lockup's claim itself, so covclaimd stops being a single point of failure on the offline path. covclaimd needs the sealed claim packet because it does not hold the preimage; this server generates it (`src/intent-swap.ts`), so with the flag set (plus `OFFLINE_EMULATOR_URL`) it pushes the **same** covenant leaf covclaimd does — `nonInteractiveClaim` — from `src/self-claim.ts`. That leaf is `preimage + Arkade operator + an emulator key tweaked by `enforcePayTo(receiverPkScript)``, with `receiverPkScript` being the user's registered Arkade address, so: this server cannot redirect the payout (it holds neither required key — that follows from the tapscript alone), and no other pusher can either (the emulator signs only after checking the spend satisfies the covenant). **No key is added and nothing is taken from the user**: the user keeps `claimPublicKey` in the covenant's `receiver` role and with it the collaborative `claim` and `unilateralClaim` leaves — this is an extra pusher, not a transfer of control. The unconstrained collaborative `claim` leaf is deliberately not used; spending it would make the server custodial for in-flight swaps. Built from public SDK primitives (`buildOffchainTx` + `EmulatorPacket`/`Extension` + `attachPrevArkTxs`, pushed via `RestEmulatorProvider`), and driven from the offline settlement poller once the indexer shows a spendable VTXO at the lockup. Claims skip an underfunded lockup rather than reveal the preimage for less than the quote's `to_amount`, are idempotent on an already-spent lockup, and a failing claim never blocks the settlement status check. A missing `OFFLINE_EMULATOR_URL` with the flag on fails at startup, not at claim time; it must name the emulator whose `emulator_pub_key` `COVCLAIMD_URL` reports, and startup warns (naming both keys) when the two disagree — a warning rather than a refusal to start, so a boot-time network blip cannot take the server down, and silent when either is unreachable. A rotated emulator counts as a match via `deprecatedSignerPubkeys`, since covenants built under the retired key remain satisfiable. Registrations are in-memory, so swaps quoted before a restart fall back to covclaimd.
- **ClaimPacket TLV codec** (`src/claim-packet.ts`) — encode/decode for the Arkade extension packet body covclaimd matches on (type `0x04`; TLVs `0x01` ciphertext, `0x02` arkade_script, `0x03` covclaimd_pub_key), transcribed from covclaimd's `pkg/preimage/packet.go`. Groundwork for the non-interactive claim path in which the funder stamps the packet into the lockup's funding transaction instead of revealing it to covclaimd over HTTP ([arkade-os/intent-solver#46](https://github.com/arkade-os/intent-solver/issues/46)); Wired behind `OFFLINE_STAMP_CLAIM_PACKET` (default off): with it set, the callback sends `0x01` ciphertext + `0x03` covclaimd_pub_key instead of the bare ciphertext, so the solver stamps the packet on chain and the covclaimd is ours to choose rather than something both sides must have been configured with. Off by default because a solver predating that PR forwards the packet as a ciphertext, cannot decrypt it, and the swap funds and refunds.
- **LUD-21 (`verify`)** — LNURL-pay callback responses now carry a `verify` URL, and a new `GET /lnurl/verify/:paymentHash` lets payers poll settlement status (`{ status, settled, preimage, pr }`). Because this server is a relay with no Lightning node, wallets report settlement via the new authenticated `POST /lnurl/session/:id/settled` with `{ preimage }` — the server checks `sha256(preimage)` against a payment hash the session issued (decoded locally from the bolt11, no new dependency) before flipping the record to settled. Settlement records live in a new `settlements` table (migration 003) when `DB_PATH` is set, or in an in-memory store with a `VERIFY_TTL_MS` (default 24h) lifetime otherwise, so a payer can still poll `verify` after the wallet disconnects. Available on both the ephemeral LNURL and the LN-address (LUD-16) flows.
- **Offline receive (opt-in)** — when `SOLVER_URL` + `COVCLAIMD_URL` + `ARK_SERVER_URL` are set, an LN address can register an Arkade receive identity via `POST /lnurl/address/:username/arkade` and receive while its wallet is offline: the server requests a quote on the Arkade intents corridor (`lightning:BTC -> arkade:BTC`) from an intent solver over Nostr RFQ (`SOLVER_PUBKEY` + `NOSTR_RELAYS`; or `SOLVER_URL` for HTTP dev/custom solvers), returns the solver's hold invoice, covclaimd claims the solver-funded VHTLC (covenant-constrained to the user via `enforcePayTo`, so it can't redirect funds), and LUD-21 `verify` reports settlement from the solver's RFQ status. The server holds no user keys or funds; it generates the preimage and seals it to covclaimd inside the quote request. Adds `settlements.swap_id` (migration 004) and per-address `arkade_address` / `claim_public_key` (migration 005). The corridor client is vendored (`src/vendor/arkade-swap/`, byte-exact from arkade-os/ts-sdk) until `@arkade-os/swap` ships the receive corridors. The wire contract was live-probed against the public mutinynet solver (`scripts/probe-solver.ts`); a full funded swap remains the operator's pre-production check.
- **Payment options (LUD-XX, `paymentOptions`)** — an LN address with a registered Arkade identity now advertises `paymentOptions: [lightning, arkade]` in its LUD-06 `payRequest`. A payer selects a rail with `?paymentOption=<id>`: `lightning` (or absent) keeps the existing BOLT11 / offline-swap flow; `arkade` returns the user's Arkade address as a `paymentDestination` (direct receive, no swap) plus a `verify` URL that reports the non-`pr` LUD-21 shape (`{ settled, paymentOption, paymentDestination, paymentReference }`). Unknown/unavailable options return `{ status: "ERROR", reason: "Unsupported paymentOption" }`. Settlement records carry the option + destination + agreed amount (migration 006, incl. `amount_msat` so the future watcher can correlate observed payments). Because the payer pays the Arkade address directly, the server isn't in the payment path, so arkade `settled` stays `false` until a server-side Arkade watcher observes the payment (follow-up). The resolver is a small registry (`src/payment-options.ts`) so future rails/assets slot in.
- **Payment quote (LUD-XX, `paymentQuote`)** — when a `QuoteProvider` is injected, the LN-address `payRequest` advertises `units` (e.g. USD), and a callback with `?unit=<code>` (optionally `&receiveUnit=`) is quoted: the provider converts the unit amount to the effective msat amount used for the bolt11 / offline swap, and the response echoes `paymentQuote` (`{ requested, payment, receive?, fees? }`). This server has no rate oracle, so without a provider `units` is omitted and any `unit=` request returns `Unsupported unit`. Framework only — real rate sourcing, assets, and swap-backed quotes plug in behind `QuoteProvider` (`src/quote-provider.ts`). Applies to the amount-denominated Lightning path (relay + offline swap); quoting the `arkade` destination rail is a follow-up.
- **Arkade settlement watcher** — when `ARK_SERVER_URL` is set, a background poller watches the Arkade indexer for payments to destination-rail records (`paymentOptions: arkade`) and flips `verify` to `settled: true` with `paymentReference` = the observed Arkade txid. Matching is by destination script + agreed amount (`amount_msat`, never under-paid) + arrival window; each observed VTXO settles at most one record, oldest first. Correlation fuzziness (an unrelated same-amount payment in the same window) is inherent to reference-less address payments and is documented in the README.
- **Solver discovery** — with `SOLVER_REGISTRY_URL` set (and no explicit solver transport), the cheapest lightning-corridor solver is picked from a [solver-registry](https://arkade-os.github.io/solver-registry/) index (`src/solver-discovery.ts`), and its card's amount bounds are enforced before quoting (`amount … is outside the corridor's min–max sats bounds` instead of a bare solver refusal). Also: the callback's `pr` response now echoes `paymentOption: "lightning"` when the wallet explicitly selected it (LUD-XX SHOULD).
- **Admin settlements view** — `GET /admin/api/settlements` (filter: `settled`, `option`, `limit`) lists LUD-21 settlement records (relay invoices, offline corridor swaps, destination-rail payments) newest-first, never exposing preimages or invoices; plus a Settlements tab in the admin SPA with a 5s live poll.

## 0.2.6 - 2026-06-04

### Added
- **Admin API documentation** — a dedicated OpenAPI/Swagger spec for the admin API, served on the admin port at `GET /admin/api/docs` (Redoc page) and `GET /admin/api/openapi.json`. Documents every admin endpoint (domains, addresses, API keys, blacklist, sessions, settings) with request/response shapes and error codes. The admin SPA nav gained an "API Docs ↗" link. The spec's version is sourced from the public spec so the two can't drift. (Kept separate from the public spec by design — the admin API runs on the loopback-bound admin port behind your auth proxy.)

## 0.2.5 - 2026-06-04

### Fixed
- The OpenAPI/Swagger docs (served at `/`) only listed the original four relay endpoints — the public endpoints added in 0.2.0 were never documented, so the page looked unchanged across releases despite the version bump. Documented the missing public endpoints: `POST /lnurl/address` (register/claim), `GET /lnurl/address` (list own), `DELETE /lnurl/address/{username}` (revoke own), and the LUD-16 `GET /.well-known/lnurlp/{username}` + `/callback` routes, with request/response shapes and error codes. (The admin API stays out of the public spec by design — it runs on the separate admin port.)

## 0.2.4 - 2026-06-04

### Added
- Admin **Sessions** tab: a live view of every connected wallet (the in-memory SSE session map, polled every 5s), joined to the `addresses` table so each connection shows the LN address(es) it belongs to. Per session: bound addresses, reusable-vs-ephemeral type, connected-since, client IP (as seen through `trust proxy`), invoices issued (+ last-issued time), and the in-flight payer request (amount + how long it's been waiting). A **Disconnect** action force-closes a session (`POST /admin/api/sessions/:id/disconnect`). The session token is never exposed. The Dashboard gains a "Live sessions" count.

## 0.2.3 - 2026-06-04

### Added
- Admin **Settings** tab: edit the runtime-soft settings — min/max sendable, invoice timeout, base URL, registration rate limit — live, with the env var as the default and a DB override that can be reset. Plus a read-only view of the process/secret config (ports, bind, DB path, trust-proxy, bootstrap domain, and token-key *status* — never the value) which can only change via env + restart. Backed by a new `settings` table (migration 002) and read per-request so overrides apply without a restart; env-only/secret vars are intentionally not editable.

## 0.2.2 - 2026-06-04

### Added
- Admin SPA editing across all tabs: a domain editor (allocation modes, require-API-key, enabled, username rules, max-per-wallet, per-domain amount limits) saved via `PATCH /admin/api/domains/:id`; reactivate + delete addresses (not just revoke) with search and status filters; API-key creation scoped to a domain (and scope shown in the list); and a new **Blacklist** tab to list/add/remove global and per-domain entries.

### Fixed
- Admin `GET /admin/api/blacklist` returned only global entries when unfiltered; it now returns all entries (global + per-domain) via a new `listAll()`.

## 0.2.1 - 2026-06-04

### Fixed
- Server crashed at startup with `ERR_MODULE_NOT_FOUND: Cannot find package 'sqlite'` whenever `DB_PATH` was set: tsup's `removeNodeProtocol` stripped the `node:` prefix from the bundled `node:sqlite` import, and `node:sqlite` is a prefix-only builtin (there is no bare `sqlite`). Disabled prefix stripping (`tsup.config.ts`) and added a build-time smoke test that boots the bundled CLI with persistence enabled, so a mangled builtin import fails the build/release instead of reaching production.

## 0.2.0 - 2026-06-04

### Added
- **SQLite persistence** — opt-in via `DB_PATH`; without it the service is fully in-memory as before. Uses Node's built-in `node:sqlite` module.
- **Encrypted token storage** — wallet session tokens are stored AES-256-GCM encrypted when `DB_PATH` is set; `TOKEN_ENCRYPTION_KEY` (32-byte hex/base64) is required. `ALLOW_INSECURE_TOKEN_STORAGE=1` dev escape hatch stores tokens in plaintext.
- **LN Address (LUD-16)** — `/.well-known/lnurlp/:username` and `/callback` resolution. Host-based multi-domain routing: the `Host` header selects the domain. Returns an error when the wallet's SSE session is offline.
- **Address provisioning** — unified `POST /lnurl/address` supporting self-claim (wallet chooses username), random assignment, and reserved-address claiming via `claimCode`. `GET /lnurl/address` lists own addresses by Bearer token; `DELETE /lnurl/address/:username` revokes an owned address.
- **Per-domain provisioning policies** — `allocationModes` (`self`/`random`/`admin`), `requireApiKey`, `max_per_session`, username length/pattern rules, per-domain or global blacklist, registration rate limit (`REGISTRATION_RATE_LIMIT`).
- **Admin JSON API** on `ADMIN_PORT` (default 3001, bound to `127.0.0.1`): full CRUD for domains, addresses (reserve/mint), API keys, blacklist; read-only view of active sessions.
- **Admin React SPA** served at the admin port root — dashboard, domains, addresses, and API keys tabs.
- **`BOOTSTRAP_DOMAIN`** env var — creates a default domain on first startup if none exist.
- **`TRUST_PROXY`** env var — configures Express `trust proxy` for correct client IPs and origins behind a reverse proxy.

## 0.1.0

### Added
- LNURL-pay service with SSE-based wallet sessions (LUD-06)
- Amountless Lightning receives via reverse swaps
- Reusable sessions: wallet sends a token, server derives a deterministic sessionId via SHA-256
- Session hijack prevention by construction (different tokens always produce different sessionIds)
- Token-based authentication for invoice endpoints
- Multi-arch Docker image (amd64 + arm64) published to GHCR
- Input validation for token (hex, minimum length)
- Comment passthrough to wallet via SSE events
