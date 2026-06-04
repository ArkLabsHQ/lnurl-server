# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
