# Arkade demo wallet

A minimal browser wallet that drives a receive page through `lnurl-server`. It exists to
exercise the protocol end to end — onboarding, offline receive and wallet-to-wallet
payment — against the mutinynet instance, not to be a wallet anyone keeps money in.

```sh
pnpm install
pnpm --filter @arkade-os/lnurl build:client   # the wallet consumes the client's dist
pnpm --filter @arkade-os/lnurl-demo-wallet dev
```

Then open http://localhost:5173. Endpoints live in `src/config.ts`.

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

## Scope

Send pays the `arkade` rail: it resolves the target, asks the callback for that rail, and
pays the returned Arkade destination with `wallet.send`. It cannot pay a BOLT11 invoice —
that needs a swap this demo does not implement — and says so rather than pretending.

Funding is manual: the Receive tab shows a boarding address to send mutinynet BTC to.
