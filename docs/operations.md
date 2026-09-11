# Production operations

Run one instance against one SQLite file. Put the public port behind TLS and put the admin port behind an authentication proxy. Do not horizontally scale this deployment: session state is process-local and SQLite has a single-writer contract.

## Deploy

1. Copy `.env.production.example` to `.env.production` and replace every example value.
2. Generate `TOKEN_ENCRYPTION_KEY` as 32 random bytes encoded as 64 hex characters. `ALLOW_INSECURE_TOKEN_STORAGE=1` is an explicit alternative for operators who accept source-known at-rest token protection; never set both.
3. Put zero or more cards in `solver-cards.json` as a JSON array. Cards pasted through the admin UI are stored in SQLite and do not need this file.
4. Set `LNURL_SERVER_IMAGE` to a pinned tag or digest, then run `docker compose --env-file .env.production -f compose.production.yml up -d`.
5. Route public HTTPS traffic to port 3000. Route authenticated operator traffic to port 3001 over the internal Docker network; do not publish port 3001 directly.

`GET /livez` means the process can answer HTTP. `GET /readyz` means it is accepting traffic and all registered critical checks pass. Remove an instance from service when readiness returns 503, but restart it only when liveness fails or an operator has identified a persistent dependency/configuration fault.

## Solver cards

Registry URLs and manual cards are the only solver configuration. `SOLVER_URL`, `SOLVER_PUBKEY`, `NOSTR_RELAYS`, and singular `SOLVER_REGISTRY_URL` are rejected at startup.

Paste a card in the admin UI's Solvers tab. The response distinguishes `persisted` from `active`; a valid card can remain inactive when it targets another network or the refreshed snapshot cannot use it. Registry responses are cached for at most seven days. Readiness fails when no current registry or manual card can serve Lightning receive.

## Backup and restore

Quiesce writes before copying SQLite. The safest sequence is:

```bash
docker compose --env-file .env.production -f compose.production.yml stop lnurl-server
docker run --rm -v lnurl-data:/data -v "$PWD/backups:/backup" alpine \
  sh -c 'cp /data/lnurl.sqlite /backup/lnurl-$(date +%Y%m%d-%H%M%S).sqlite'
docker compose --env-file .env.production -f compose.production.yml start lnurl-server
```

To restore, stop the service, preserve the current file separately, copy the chosen backup to `/data/lnurl.sqlite`, retain ownership for the image's `node` user, then start and verify `/readyz`, the domain list, discovery status, and recent settlements.

Migration 8 deliberately blocks when an older database contains unsettled offline swaps without recovery rows. Let those swaps settle or expire under the old release before upgrading. Do not delete them merely to bypass the guard.

## Canary and rollback

Before shifting traffic, require a 200 from `/readyz`, inspect `/admin/api/discovery`, open an SSE wallet session, and perform a small funded offline receive through LUD-21 verification. A rollback may reuse the database only when the older release understands its schema; otherwise restore the pre-deploy backup. Never run old and new instances against the same SQLite volume.

## Shutdown and incidents

Send `SIGTERM` and allow at least `SHUTDOWN_TIMEOUT_MS` plus a small orchestrator margin. The service first becomes unready, stops schedulers, closes SSE sessions/listeners and Nostr transports, then closes SQLite. A second signal forces termination.

Treat an unavailable registry with a fresh cache as degraded but serviceable. Treat an expired cache with no manual card as unavailable. For solver failures, correlate the `X-Request-Id` response header with structured logs; token, preimage, invoice, authorization, and private-key fields are centrally redacted.
