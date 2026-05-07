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

Tests use vitest with real HTTP servers (no mocks). Each test starts a server on a random port.

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

- `src/server.ts` — Express app with SSE session endpoints and LNURL-pay protocol
- `src/session-manager.ts` — Session lifecycle, SSE streaming, invoice request/response flow
- `src/types.ts` — Shared TypeScript types
- `src/cli.ts` — CLI entrypoint reading config from env vars
