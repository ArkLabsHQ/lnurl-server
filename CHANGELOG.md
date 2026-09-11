# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added
- **Production runtime and card-only solver discovery** — uses `@arkade-os/solver-discovery` across multiple registries, cached indexes, startup cards, and cards pasted into the admin UI. Direct `SOLVER_URL` / pubkey / relay configuration is removed. Accepted offline swaps atomically persist solver and VHTLC recovery state for restart-safe polling/self-claim. Adds liveness/readiness endpoints, resource caps, redacted structured logs, graceful shutdown, a non-root image, reference Compose deployment, and an operations runbook.
- **Self-claim (`OFFLINE_SELF_CLAIM`, default off)** — the server can push the solver-funded lockup's `nonInteractiveClaim` leaf itself, while the covenant and emulator still constrain payment to the user's registered address. Claims skip underfunded lockups, are safe to retry, and never block status polling. Versioned VHTLC reconstruction data is now persisted atomically with accepted swaps, so self-claim resumes after restart.
- **ClaimPacket TLV codec** (`src/claim-packet.ts`) — encode/decode for the Arkade extension packet body covclaimd matches on (type `0x04`; TLVs `0x01` ciphertext, `0x02` arkade_script, `0x03` covclaimd_pub_key), transcribed from covclaimd's `pkg/preimage/packet.go`. Groundwork for the non-interactive claim path in which the funder stamps the packet into the lockup's funding transaction instead of revealing it to covclaimd over HTTP ([arkade-os/intent-solver#46](https://github.com/arkade-os/intent-solver/issues/46)); Wired behind `OFFLINE_STAMP_CLAIM_PACKET` (default off): with it set, the callback sends `0x01` ciphertext + `0x03` covclaimd_pub_key instead of the bare ciphertext, so the solver stamps the packet on chain and the covclaimd is ours to choose rather than something both sides must have been configured with. Off by default because a solver predating that PR forwards the packet as a ciphertext, cannot decrypt it, and the swap funds and refunds.
- **LUD-21 (`verify`)** — LNURL-pay callback responses now carry a `verify` URL, and a new `GET /lnurl/verify/:paymentHash` lets payers poll settlement status (`{ status, settled, preimage, pr }`). Because this server is a relay with no Lightning node, wallets report settlement via the new authenticated `POST /lnurl/session/:id/settled` with `{ preimage }` — the server checks `sha256(preimage)` against a payment hash the session issued (decoded locally from the bolt11, no new dependency) before flipping the record to settled. Settlement records live in a new `settlements` table (migration 003) when `DB_PATH` is set, or in an in-memory store with a `VERIFY_TTL_MS` (default 24h) lifetime otherwise, so a payer can still poll `verify` after the wallet disconnects. Available on both the ephemeral LNURL and the LN-address (LUD-16) flows.
- **Offline receive (opt-in)** — with solver cards plus `COVCLAIMD_URL` and `ARK_SERVER_URL`, an LN address can register an Arkade receive identity and receive while its wallet is offline. The server obtains a Nostr RFQ through the ranked card candidates, returns the verified hold invoice, and tracks the pinned solver through LUD-21 settlement without holding user keys or funds.
- **Payment options (LUD-XX, `paymentOptions`)** — an LN address with a registered Arkade identity now advertises `paymentOptions: [lightning, arkade]` in its LUD-06 `payRequest`. A payer selects a rail with `?paymentOption=<id>`: `lightning` (or absent) keeps the existing BOLT11 / offline-swap flow; `arkade` returns the user's Arkade address as a `paymentDestination` (direct receive, no swap) plus a `verify` URL that reports the non-`pr` LUD-21 shape (`{ settled, paymentOption, paymentDestination, paymentReference }`). Unknown/unavailable options return `{ status: "ERROR", reason: "Unsupported paymentOption" }`. Settlement records carry the option + destination + agreed amount (migration 006, incl. `amount_msat` so the future watcher can correlate observed payments). Because the payer pays the Arkade address directly, the server isn't in the payment path, so arkade `settled` flips only when the server-side Arkade watcher observes the payment — which ships in this same release, below. The resolver is a small registry (`src/payment-options.ts`) so future rails/assets slot in.
- **Payment quote (LUD-XX, `paymentQuote`)** — when a `QuoteProvider` is injected, the LN-address `payRequest` advertises `units` (e.g. USD), and a callback with `?unit=<code>` (optionally `&receiveUnit=`) is quoted: the provider converts the unit amount to the effective msat amount used for the bolt11 / offline swap, and the response echoes `paymentQuote` (`{ requested, payment, receive?, fees? }`). This server has no rate oracle, so without a provider `units` is omitted and any `unit=` request returns `Unsupported unit`. Framework only — real rate sourcing, assets, and swap-backed quotes plug in behind `QuoteProvider` (`src/quote-provider.ts`). Applies to the amount-denominated Lightning path (relay + offline swap); quoting the `arkade` destination rail is a follow-up.
- **Arkade settlement watcher** — when `ARK_SERVER_URL` is set, a background poller watches the Arkade indexer for payments to destination-rail records (`paymentOptions: arkade`) and flips `verify` to `settled: true` with `paymentReference` = the observed Arkade txid. Matching is by destination script + agreed amount (`amount_msat`, never under-paid) + arrival window; each observed VTXO settles at most one record, oldest first. Correlation fuzziness (an unrelated same-amount payment in the same window) is inherent to reference-less address payments and is documented in the README.
- **Solver discovery** — `SOLVER_REGISTRY_URLS`, a startup card file, and admin-pasted cards merge into one atomically refreshed, fee-ranked discovery snapshot with bounded registry caching.
- **Admin settlements view** — `GET /admin/api/settlements` (filter: `settled`, `option`, `limit`) lists LUD-21 settlement records (relay invoices, offline corridor swaps, destination-rail payments) newest-first, never exposing preimages or invoices; plus a Settlements tab in the admin SPA with a 5s live poll.

### Security
- **Patched express's transitive dependencies** — `path-to-regexp` 8.3.0 → 8.4.2 (high severity), `qs` 6.15.0 → 6.16.0, and `body-parser` 2.2.2 → 2.3.0, which between them clear every advisory open against code this server actually ships. Lockfile only: express 5.2.1 is already the newest release, and the ranges it and `router` declare already allowed the patched versions, so nothing in `package.json` changed. The advisories left open after this are all dev-only (`vite`, `postcss`, `nanoid`, `esbuild`, and the `form-data` under `supertest`) and none reach the published image, whose final stage installs `--prod` and copies only `dist`.

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
- **Token storage** — wallet session tokens use AES-256-GCM with a private `TOKEN_ENCRYPTION_KEY`; `ALLOW_INSECURE_TOKEN_STORAGE=1` explicitly selects a source-known fallback key when the operator accepts that it provides no database confidentiality.
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
