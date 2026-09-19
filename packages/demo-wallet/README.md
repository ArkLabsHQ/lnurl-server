# Arkade demo wallet

A minimal browser wallet that drives a receive page through `lnurl-server`. It exists to
exercise the protocol end to end — onboarding, offline receive and wallet-to-wallet
payment — against the mutinynet instance, not to be a wallet anyone keeps money in.

Published on every merge to `main` at
**https://arklabshq.github.io/lnurl-server/**, pinned to the mutinynet instance.
It is a static bundle with no backend of its own.

```sh
pnpm install
pnpm --filter @arkade-os/lnurl build:client   # the wallet consumes the client's dist
pnpm --filter @arkade-os/lnurl-demo-wallet dev
```

Then open http://localhost:5173. Endpoints live in `src/config.ts`; the wallet is
mutinynet-only and reads its LNURL domain from there rather than from
`location.hostname`, which on Pages is the GitHub host and has nothing to do with
the LNURL server.

`DEMO_WALLET_BASE` sets the asset prefix: a Pages project site is served from
`/<repo>/`, and the workflow passes it. Unset, it builds for a root-served host.

## Pointing it at a local stack

The shipped defaults are mutinynet, but the endpoint record in `localStorage`
carries a network layer too — `network`, `emulatorPubkey`, `solverRegistryUrl`
and `solverRfqHttpUrl`. No UI writes those; `saveNetworkOverrides` is the seam
the tests use, which is what lets `pnpm test:browser:local` drive this bundle
against a regtest stack without a separate build.

`IS_MAINNET` is deliberately **not** reachable from any stored value. Every
selectable network derives BIP44 coin type 1, so a record that could flip it
would hand the same phrase different keys and no way back to the old ones.

Two things a local stack does not provide, supplied by the Vite dev/preview
server (`DEMO_WALLET_SOLVER_PROXY`, `DEMO_WALLET_SOLVER_REGISTRY`): the solver
sends no CORS headers, so `/solver` is proxied same-origin, and its card is in
no published registry, so one is served built from that card. Neither affects a
production build, where the registry is public and nostr is not preflighted.

## What onboarding does

1. Generates a BIP39 mnemonic and an Arkade identity from it.
2. Opens an SDK `Wallet` against the Arkade Service.
3. Derives the session token for the LNURL domain.
4. Claims a username — the LUD-16 address.
5. Binds the Arkade identity to that username.

Steps 4 and 5 are one action on purpose. Until the bind lands the payRequest advertises
no `paymentOptions` at all, so an address stuck between them is one that silently cannot
receive offline. `test/onboard.test.ts` pins both directions of that against a real server.

## Two traps this code exists to avoid

**Token derivation must pin ECDSA.** `deriveSessionTokenForIdentity` does. Calling
`identity.signMessage` yourself defaults to randomised schnorr — the same 64 bytes, so
nothing about the result looks wrong — which mints a fresh token per call and orphans the
registered address.

**The wallet deliberately opens no SSE session.** An open session makes the
`interactive-lightning` rail available, so the server would ask this wallet for a BOLT11
invoice. It has no Lightning node and would have to reject, failing the payer. Staying out
of the session is what lets the server fall through to the offline-swap rail, where a
solver mints the invoice instead.

## Why it is a browser app

`Wallet.create` defaults to IndexedDB repositories and the SDK needs a global
`EventSource`. Both are browser natives; in Node the same code needs repositories and an
event-source factory injected.

## Send routes through the SDK's PaymentRouter

Send does not choose a rail itself. It builds a `PaymentRouter`
(`src/router.ts`), registers the LNURL rails from
`@arkade-os/lnurl-client/arkade`, and asks `options()` what can pay the target.
So the same box accepts a Lightning address, an LNURL, an Arkade address or an
on-chain address, and the policy is one array — `RAIL_PRIORITY` — rather than a
branch in the send path.

An LNURL rail is a decorator: it resolves the target, asks the callback for its
`paymentOption`, and delegates the resulting destination to the rail that
already pays that kind of target. `lnurl-arkade` delegates to `arkRail`, and
`lnurl-lightning` delegates to the solver rail in `src/lightning.ts`, which pays
a BOLT11 from Arkade funds over the solver's `BTC/lightning:BTC` corridor.

That rail picks its RFQ transport rather than hardcoding one, because the wrong
choice fails as an *empty market* — indistinguishable from "no solver serves
this". A deployed solver listens on nostr; one running `serve` answers HTTP and
never subscribes to a relay. So `solverRfqHttpUrl`, when set, routes over HTTP,
and otherwise the production nostr transport is loaded dynamically — keeping the
optional `nostr-tools` peer out of the bundle when it is not used.

Options are quoted **on click, not on listing**: a quote asks the callback for
an invoice, so pricing every option up front would mint one per rail and
abandon all but one.

Funding is manual: the Receive tab shows a boarding address to send mutinynet BTC to.
