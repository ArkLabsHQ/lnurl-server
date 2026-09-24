# lnurl-server

LNURL-pay service for amountless Lightning receives via Arkade wallet reverse swaps.

## Development

```bash
pnpm dev          # start dev server with hot reload
pnpm build        # build with tsup
pnpm test         # run tests
pnpm type-check   # typecheck without emitting
```

## Testing

Four layers, each proving something the one below it cannot:

```bash
pnpm test               # vitest, real HTTP servers, no mocks — each test on a random port
pnpm test:e2e           # funded offline receive + restart recovery, on a local Arkade stack
pnpm test:browser:local # the wallet in Chromium, every rail, against that same local stack
pnpm test:browser       # the wallet in Chromium against live mutinynet (costs real sats)
```

The two stack suites raise arkade-regtest from the `regtest` submodule and need Docker; they
pull the solver image pinned in `test/e2e/support/regtest.ts`. `pnpm test:browser:local` is the
feature-matrix gate — a green `pnpm test` says nothing about a browser, and the wallet has
shipped fully broken past one. `@funded`/`@provision` specs in the mutinynet suite need a
hand-funded wallet and are skipped in CI.

The local stack's intent-solver allows 5 quotes per 15 minutes per requester IP (hard-coded in
solver-core). The budget lives in the solver's memory and global setup restarts the solver, so it
resets every run; a run needing more has the rest refused (send-rails fails loudly when it is).

## Releasing

Releases are driven by the `version` field in `package.json`:

```bash
# 1. Update version in package.json
# 2. Update CHANGELOG.md with the new version's changes
# 3. Commit and push to main: "release: v0.2.0"
```

On push to `main`, CI reads the version from `package.json` and checks if a matching git tag exists. If not, it automatically:
- Builds and pushes Docker image to `ghcr.io/arklabshq/lnurl-server:{version}` + `latest`
- Creates the `v{version}` git tag
- Creates a GitHub Release with changelog content extracted from CHANGELOG.md

## Changelog

Maintain `CHANGELOG.md` between version bumps. Add entries under an `## Unreleased` section as changes are merged. When cutting a release, rename `Unreleased` to the version number.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):
- **Added** for new features
- **Changed** for changes in existing functionality
- **Fixed** for bug fixes
- **Removed** for removed features

## Architecture

- `src/server.ts` — Composes the public Express app: middleware, `ServerContext` (`src/server-context.ts`), routers, error handlers
- `src/routes/` — Routers only, one file per URL group: `lnurl-session` (wallet SSE), `lnurl-pay` (LUD-06/21 for a session), `well-known` (LUD-16), `lnurl-address` (owner REST), `health`, `docs`, and `admin/` (mounted by `src/admin-server.ts`). Shared logic lives outside: `src/pay-flow.ts`, `src/reconcile.ts`, `src/http-params.ts`
- `src/errors.ts` — Domain errors, each with a `kind`; none knows HTTP
- `src/http-errors.ts` — HTTP errors (`LnurlError` → LUD-06 body; `BadRequest`/`NotFound`/… → `{ error }`), the exhaustive domain `kind` → status map, and the handlers that answer both
- `src/session-manager.ts` — Session lifecycle, SSE streaming, invoice request/response flow
- `src/types/` — Shared TypeScript types by topic (config, session, lnurl, db) behind `index.ts`
- `src/cli.ts` — CLI entrypoint reading config from env vars
- `src/intent-swap.ts` — Offline receive: card-discovered `lightning:BTC -> arkade:BTC` corridor swaps via the published `@arkade-os/swap` package (`SOLVER_REGISTRY_URLS` / `SOLVER_CARDS_FILE`, plus `COVCLAIMD_URL` + `ARK_SERVER_URL`)
- `src/self-claim.ts` — Optional server-side lockup claim (`OFFLINE_SELF_CLAIM` + `OFFLINE_EMULATOR_URL`): pushes the covenant's `nonInteractiveClaim` leaf — operator + emulator signatures, gated on the preimage we hold — so covclaimd isn't a single point of failure. Needs no key; the covenant pins the payout to the user. Never the collaborative `claim` leaf, which has no output constraint
- `src/covenant-destination.ts` + `src/covenant-sweeper.ts` — Per-payment arkade-rail addresses (`OFFLINE_COVENANT_DESTINATIONS`): three leaves (covenant sweep pinned to the user's static address, user+operator, user-alone CSV), so the script identifies the payment instead of amount/arrival guesswork. Every leaf must be a valid vtxo script — arkd rejects a taptree containing anything else, which is why the per-payment nonce rides in the condition
- `src/arkade-watcher.ts` — Static-address destination-rail watcher: those payments land at an address the server does not control, so amount/window correlation is all there is. Covenant destinations do not come through here
- `src/covenant-contract.ts` + `src/contract-store.ts` — The covenant as an SDK contract type. Registering a `ContractHandler` is what lets `ContractManager` track, watch and spend it, so the subscription, the one-shot `awaiting-funds` lifecycle and leaf selection are the SDK's rather than ours
- `src/covenant-watcher.ts` — Settlement for covenant destinations, from contract events. Nothing polls; a catch-up pass at subscribe time covers payments made while the process was down
- `src/payment-options.ts` — LUD-XX paymentOptions rail registry (advertise + resolve)
- `src/quote-provider.ts` — LUD-XX paymentQuote framework (injected rate oracle seam)
- `src/settlement-store.ts` + `src/offline-poller.ts` — LUD-21 settlement records (memory/SQLite) and the offline-swap status poller
- `scripts/probe-solver.ts` — live solver quote probe (operator diagnostic; funds nothing)
- `scripts/probe-covenant.ts` — the same for the covenant rail: derives a destination from a network's real operator + emulator keys, so a config that would silently fall back to the static address fails here instead of on a payer's money
- `scripts/inspect-funding.ts` — why a funded lockup never claimed: reports the claim packet and output taptree covclaimd needs, both of which it declines at debug level
