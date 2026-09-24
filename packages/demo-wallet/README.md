# Arkade demo wallet

A small browser wallet that uses every feature of `@arkade-os/lnurl-client`. It is a
working usage guide, not a wallet to keep money in.

Published on every merge to `main` at **https://arklabshq.github.io/lnurl-server/**,
pointed at the mutinynet instance. It is a static bundle with no backend of its own.

```sh
pnpm install
pnpm --filter @arkade-os/lnurl build:client   # the wallet consumes the client's dist
pnpm --filter @arkade-os/lnurl-demo-wallet dev
```

Open http://localhost:5173. Every main action has a collapsed **"the call behind this"**
under it, showing the client code that action runs.

## Feature map

| Feature | Where in the demo | Client call | Read more |
| --- | --- | --- | --- |
| What the domain allows | Onboarding (which buttons appear) | `createLnurlClient({ baseUrl }).domainCapabilities({ domain })`, or `lnurl.capabilities()` | [client: With an Arkade wallet](../client/README.md#with-an-arkade-wallet) |
| Choose a name | Onboarding → username + **Create wallet** | `lnurl.claim({ username })` | [LUD-16](https://github.com/lnurl/luds/blob/luds/16.md) |
| Random name | Onboarding → **Pick a name for me** | `lnurl.claim()` | [client](../client/README.md#with-an-arkade-wallet) |
| No name, just a LNURL | Onboarding → **Skip — just a LNURL** | `lnurl.claim({ nameless: true })` | [client](../client/README.md#with-an-arkade-wallet) |
| Operator-reserved name | Onboarding → **I have a claim code** | `lnurl.claim({ username, claimCode })` | [Enabling modes](#enabling-modes-on-your-local-stack) |
| Name a nameless LNURL | Receive → **Add a name** (+ claim code) | `receiver.upgrade({ username })` / `({ username, claimCode })` | [client](../client/README.md#with-an-arkade-wallet) |
| Find the wallet again | Page load, restore from phrase | `lnurl.owned()` | [client](../client/README.md#with-an-arkade-wallet) |
| Offline receive | Receive → any rail, page closed | `lnurl.claim(...)` binds the identity | [client: Offline receive](../client/README.md#offline-receive) |
| Rails | Receive → **Load options**, **Request** per rail | `receiver.payRequest()`, `payer.requestInvoice(pr, { amountSat, paymentOption })` | [client: Payer](../client/README.md#payer) |
| Watch many receives, one connection | Receive → the list under the invoice | `payer.openVerifyBatchStream(...)` + `stream.update(add, remove)` | [client: verifyBatch](../client/README.md#many-pending-invoices-verifybatch), [LUD-XX #299](https://github.com/lnurl/luds/pull/299) |
| Confirm many sends, one request | Send → status after paying | `batchVerify(verifyBatchUrl, verifyUrls)` | [client: verifyBatch](../client/README.md#many-pending-invoices-verifybatch) |
| Preimage-checked verify | Receive/Send when no `verifyBatch` is offered | `payer.pollVerify(verifyUrl, opts)` | [client: Payer](../client/README.md#payer), [LUD-21](https://github.com/lnurl/luds/blob/luds/21.md) |
| Pay anything | Send → **Find routes**, **Pay** | `arkadePaymentRouter({ wallet, lightning }).options(...)` | [Send routing](#send-routes-through-the-sdks-paymentrouter) |
| Payment sync | Activity (every 8 s) | `receiver.sync()` + `storedPayments({ domain, handle })` | [client: Payment activity](../client/README.md#payment-activity) |

## Onboarding

The buttons come from the domain, not from the wallet:

```ts
const { allocationModes } = await createLnurlClient({ baseUrl }).domainCapabilities({ domain })
const lnurl = arkadeLnurl({ wallet, baseUrl, domain, store: browserPaymentStore() })
```

| `allocationModes` has | Button | Call |
| --- | --- | --- |
| `self` | username + **Create wallet** | `lnurl.claim({ username })` |
| `random` | **Pick a name for me** | `lnurl.claim()` |
| `session` | **Skip — just a LNURL** | `lnurl.claim({ nameless: true })` |
| `admin` | **I have a claim code** | `lnurl.claim({ username, claimCode })` |

Every choice runs `(await lnurl.owned()) ?? (await lnurl.claim(opts))`. Asking `owned()`
first means a phrase that already has an address gets it back, not a second one.

`claim` does two things in one call: it registers the address and binds the Arkade
identity. Until the bind lands, the address offers no `paymentOptions`, so it cannot
receive offline. `test/onboard.test.ts` checks both halves against a real server.

## Naming a nameless LNURL

```ts
const named = await receiver.upgrade({ username: 'alice' })              // or ({ username, claimCode })
```

The same LNURL keeps paying the wallet. But the upgrade **links it publicly** to the name:
anyone holding the LNURL can see it. To keep them unlinked, claim a separate address
with `lnurl.claim({ username: 'alice' })` instead.

## Receiving

```ts
const payRequest = await receiver.payRequest()
const invoice = await payer.requestInvoice(payRequest, { amountSat: 1000, paymentOption: 'arkade' })
```

Leave out `paymentOption` for plain Lightning. Options are fetched on click, never
up front: each request mints a destination and files a settlement record.

Every request with a `verifyBatch` URL joins **one stream per endpoint**, open for as
long as the Receive tab is. Switching tabs closes it, and invoices requested before
that are no longer watched. The status line reads "watching 2 invoices on one connection".

```ts
const stream = payer.openVerifyBatchStream(
  { verifyBatchUrl: invoice.verifyBatch, verifyUrls: [invoice.verify] },
  { onUpdate, onClose },
)
stream.update([next.verify])          // a later request joins
stream.update([], [settled.verify])   // a settled one leaves
```

The server closes the stream when everything on it has settled. If it closes while
anything is still pending, the wallet reopens it with backoff, over only the pending
set. An invoice still pending 15 minutes after its request is dropped at the next
close. The logic is `settlementWatcher` in `src/batch-verify.ts`.

With no `verifyBatch` URL, the wallet falls back to `payer.pollVerify`. That call
rejects a "settled" answer whose preimage does not hash to the invoice.

## Send routes through the SDK's PaymentRouter

Send does not pick a rail itself. It builds the SDK's `PaymentRouter` with the LNURL
rails added (`src/router.ts`) and asks what can pay the target:

```ts
const router = arkadePaymentRouter({ wallet, lightning })
const options = await router.options({ raw: target, amount }, { priority: DEFAULT_RAIL_PRIORITY })
const handle = await (await option.quote()).send()
```

So one box takes a Lightning address, an LNURL, an Arkade address or an on-chain
address. The policy is one array, `RAIL_PRIORITY`.

An LNURL rail resolves the target, asks the callback for its `paymentOption`, and hands
the result to the rail that already pays that kind of target: `lnurl-arkade` to
`arkRail`, `lnurl-lightning` to the solver rail in `src/lightning.ts`.

That solver rail picks its RFQ transport. The wrong one fails as an *empty market*,
which looks just like "no solver serves this". A deployed solver listens on nostr; one
running `serve` answers HTTP only. So `solverRfqHttpUrl`, when set, routes over HTTP;
otherwise the nostr transport is loaded on demand, keeping `nostr-tools` out of the
bundle.

Options are quoted **on click**: a quote asks the callback for an invoice.

After a send, the receiver's confirmation is batched. Every unconfirmed send at the
same endpoint is checked in one GET every 2 seconds:

```ts
const { results } = await batchVerify(verifyBatchUrl, pendingVerifyUrls)
```

## Funding

There is no deposit screen. Funding the wallet is being paid: request any rail on
Receive and pay what it returns. The `onchain` rail returns a boarding address, and the
wallet settles boarded funds on its own.

## Pointing it at a local stack

Endpoints live in `src/config.ts`. The shipped defaults are mutinynet. The wallet reads
its LNURL domain from there, not from `location.hostname`, which on Pages is the GitHub
host.

`DEMO_WALLET_BASE` sets the asset prefix: a Pages project site is served from `/<repo>/`.
Unset, it builds for a root-served host.

The endpoint record in `localStorage` also carries a network layer: `network`,
`emulatorPubkey`, `solverRegistryUrl` and `solverRfqHttpUrl`. No UI writes those;
`saveNetworkOverrides` is the seam the tests use. That is how `pnpm test:browser:local`
drives this bundle against a regtest stack without a separate build.

`IS_MAINNET` can **not** be set from any stored value. Every selectable network derives
BIP44 coin type 1, so a record that flipped it would give the same phrase different keys,
with no way back.

Two things a local stack lacks are supplied by the Vite dev/preview server
(`DEMO_WALLET_SOLVER_PROXY`, `DEMO_WALLET_SOLVER_REGISTRY`): the solver sends no CORS
headers, so `/solver` is proxied same-origin; and its card is in no published registry,
so one is served from that card. Neither affects a production build.

## Enabling modes on your local stack

A bootstrapped domain starts with `self` and `random` only. Turn on the rest through
the admin API (`ADMIN_PORT`: 3001 by default, 4284 under `pnpm test:browser:local`). It
has no authentication and binds to `127.0.0.1`.

```sh
ADMIN=http://127.0.0.1:4284/admin/api
curl -s $ADMIN/domains                                   # find your domain's id
curl -s -X PATCH $ADMIN/domains/1 -H 'Content-Type: application/json' \
  -d '{"allocationModes":["self","random","session","admin"]}'
```

Reserve a name and get its one-time claim code:

```sh
curl -s -X POST $ADMIN/addresses -H 'Content-Type: application/json' \
  -d '{"domain":"127.0.0.1","username":"alice","mode":"reserve"}'
# {"id":7,"username":"alice","domain":"127.0.0.1","status":"reserved","claimCode":"9f2c…"}
```

Then pick **I have a claim code** in the wallet, or call
`lnurl.claim({ username: 'alice', claimCode })`. The code is shown once; only its hash
is stored. The browser tests do exactly this: `setModes` and `reserveName` in
`e2e-local/local-stack.ts`.

## Two traps this code avoids

**Token derivation must pin ECDSA.** `deriveSessionTokenForIdentity` does. Calling
`identity.signMessage` yourself defaults to randomised schnorr: the same 64 bytes, so
nothing looks wrong, but it mints a new token per call and orphans the address.

**The wallet opens no SSE session.** An open session enables the `interactive-lightning`
rail, so the server would ask this wallet for a BOLT11 invoice. It has no Lightning node
and would have to refuse, failing the payer. Staying out lets the server fall through to
the offline-swap rail, where a solver mints the invoice.

## Why it is a browser app

`Wallet.create` defaults to IndexedDB repositories, and the SDK needs a global
`EventSource`. Both are browser natives; in Node you inject repositories and an
event-source factory.

## Tests

```sh
pnpm test                 # includes test/*.test.ts here: watcher, choices, onboarding
pnpm test:browser:local   # every feature in Chromium against a local regtest stack
```
