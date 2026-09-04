# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added
- **LUD-21 (`verify`)** — LNURL-pay callback responses now carry a `verify` URL, and a new `GET /lnurl/verify/:paymentHash` lets payers poll settlement status (`{ status, settled, preimage, pr }`). Because this server is a relay with no Lightning node, wallets report settlement via the new authenticated `POST /lnurl/session/:id/settled` with `{ preimage }` — the server checks `sha256(preimage)` against a payment hash the session issued (decoded locally from the bolt11, no new dependency) before flipping the record to settled. Settlement records live in a new `settlements` table (migration 003) when `DB_PATH` is set, or in an in-memory store with a `VERIFY_TTL_MS` (default 24h) lifetime otherwise, so a payer can still poll `verify` after the wallet disconnects. Available on both the ephemeral LNURL and the LN-address (LUD-16) flows.

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
