# @arkade-os/lnurl-client

Full-duplex client for the lnurl-server protocol: payer (`resolve`, `requestInvoice`, `pollVerify`) and receiver (sessions, settled reporting, address and Arkade-identity registration).

## Install

```sh
pnpm add @arkade-os/lnurl-client
```

The SDK is an optional peer: `>=0.5.0-rc.0` (0.5.0 release candidates and stable 0.5+ releases). The main entry point needs no SDK; `/arkade` uses the SDK installed by your app.

Runtime dependencies are the Scure and Noble cryptography packages; the package never imports the server, so app bundles stay free of `express` and `sqlite`.

## With an Arkade wallet

If you hold an `@arkade-os/sdk` wallet, start here. `arkadeLnurl` takes the wallet and the server root and does the rest - token derivation, claiming the address, binding the identity, the sync loop, and the send rails:

```ts
import { arkadeLnurl } from '@arkade-os/lnurl-client/arkade'
import { browserPaymentStore } from '@arkade-os/lnurl-client'

const lnurl = arkadeLnurl({ wallet, baseUrl: 'https://lnurl.example.com', store: browserPaymentStore() })

// Receive: claims the name AND binds the identity, which is what makes the
// address advertise any paymentOptions at all. Omit the name for a
// server-assigned one, or pass `{ nameless: true }` for no address at all -
// just the stable `lnurl` below.
const rx = await lnurl.claim({ username: 'alice' })   // rx.lightningAddress === 'alice@lnurl.example.com'
await rx.sync()                                       // pull the server's own records

// Send: the router already knows how to pay a Lightning address.
const [best] = await lnurl.options('bob@example.com', 1000)
const handle = await (await best.quote()).send()
```

`wallet.identity` supplies the signing, so nothing else is passed in. The token is derived once and memoised - it signs twice on first use to prove the signer is deterministic, and a second call costs nothing. `claim` and `owned` return a `Receiver`, scoped to one address:

| you want | call |
| --- | --- |
| what this domain allows | `capabilities()` |
| the LUD-16 domain it works on | `domain` |
| the active address this wallet already owns here | `owned({ refresh?, signal? })` |
| every address it owns here, revoked ones too, for display | `addresses()` |
| claim a name (or none) and bind the identity | `claim(opts?, { signal? })` |
| the LNURL a nameless claim will serve, before it lands | `sessionLnurl()` |
| its `user@domain`, or `undefined` when nameless | `receiver.lightningAddress` |
| an LNURL for a QR | `receiver.lnurl` |
| its own payRequest | `receiver.payRequest()` |
| one page of the server's records | `receiver.payments(opts)` |
| everything new, into your store | `receiver.sync({ signal? })` |
| name a nameless receiver in place | `receiver.upgrade(opts?)` |
| rank the ways to pay a target | `options(target, amountSat)` |
| the router itself | `router()` |

**`payRequest()` fetches once per 30 s.** Every call on one `Receiver` within that window shares a single fetch, in flight or done, so a screen asking on every amount change costs one GET; a failed fetch is not kept. `claim` and `upgrade` retire it at once, even when they fail; a change made anywhere else - another device, the operator - shows within 30 s. `createLnurlClient().resolve(receiver.lnurl)` always asks the server.

**Keeping aliases pointed at this wallet.** `owned({ refresh: true })` first re-binds this facade's Arkade, claim and boarding destinations on every active alias the server lists as bound elsewhere - after an address rotation or a restore - and on all of them where the server does not report it. A missing boarding address never counts as a change, so a registered one stays. An alias the server refuses does not stop the rest: they are still re-bound, then the call rejects. `claim`, `owned` and `upgrade` run one at a time per identity object and server, across facades, so a receive screen and a startup sync built separately never interleave their writes. Once a `signal` passed to `owned` or `claim` aborts, the call rejects with `signal.reason` - after any call queued ahead of it - and writes nothing more. A `claim` aborted after its address registered but before the bind leaves that address without an Arkade destination until a later `owned({ refresh: true })` binds it.

`capabilities()` reads what a domain allows before you call it - `{ domain, allocationModes, usernameRules, requireApiKey }` - so onboarding can offer only the modes actually enabled instead of guessing and hitting `forbidden_mode`. A domain requiring an operator-reserved name takes a `claimCode` the same way on either call below: `claim({ username: 'alice', claimCode })`.

**Nameless, and upgrading later.** `claim({ nameless: true })` returns a `Receiver` with no lightning address at all - offline receive, rails and payment sync all work off its stable `lnurl` alone. `receiver.upgrade({ username: 'alice' })` (or `{ username, claimCode }` for a reserved name) names it in place: the wallet keeps its history and the same `lnurl` keeps paying it, but the upgrade **publicly links** that LNURL to the new name. To keep them unlinked instead, call `lnurl.claim({ username: 'alice' })` on the side - a second, separate named address (counted against the domain's per-wallet limit) with no connection to the nameless one.

Paying needs no address of your own, so the router is available separately - `arkadePaymentRouter({ wallet, lightning })` returns the SDK router with the LNURL rails registered, which is what makes `route()` accept a Lightning address instead of throwing `no rail for`.

Receiving accepts a `LnurlWallet`: only `identity.signMessage`, `identity.compressedPublicKey`, `getAddress`, and `getBoardingAddress` are required. It does not require the SDK's concrete `Wallet` class. For sending, the default adapter expects a full SDK spending wallet. Custom wallets can pass a `LnurlPaymentRouter` as `router` to either `arkadeLnurl` or `arkadePaymentRouter`; the adapter registers the LNURL rails on that router. `LnurlPaymentRouter` requires only `use`, `remove`, `options`, and `route`, without the SDK class's private members. SDK rails and router data types remain part of the `/arkade` contract.

CI checks the client against SDK `0.5.0-rc.0` and `0.5.0-rc.19` in isolated installs, independent of the server's SDK pin. Run the same types, tests, build, and consumer checks with `node scripts/check-client-sdk-compat.mjs <sdk-version>` from the repository root.

Everything below is the surface these are built on; reach for it when the facade does not fit.

## Payer

`createLnurlClient()` with no `baseUrl` covers payer-only use: `resolve`, `requestInvoice` and `pollVerify` talk to whatever host the address or LNURL points at.

```ts
import { createLnurlClient } from "@arkade-os/lnurl-client";

const payer = createLnurlClient();

const payRequest = await payer.resolve("alice@example.com"); // or an lnurl bech32 string
const invoice = await payer.requestInvoice(payRequest, { amountSat: 50 });

// Pay invoice.pr through your own Lightning path, then wait for settlement:
if (invoice.kind === "bolt11" && invoice.verify) {
  const status = await payer.pollVerify(invoice.verify, { timeoutMs: 120_000, intervalMs: 1_000, expect: invoice });
  if (status.kind === "bolt11" && status.settled) {
    console.log("settled, preimage:", status.preimage);
  }
}
```

A settled bolt11 status is only returned when `SHA256(preimage)` equals the payment hash in `pr`. Anything else — a wrong preimage, or a `pr` that cannot be decoded — is rejected rather than reported as settled.

That proves the answer's own `pr`, not that it is the invoice you are watching. Pass the callback's answer as `expect` and an answer about any other payment — another invoice with its genuine preimage, a destination status, another destination — fails with `LnurlError` instead. lnurl rails record the same value on their quotes as `lnurlQuoteMeta(quote).expect`; for batched or streamed answers, `verifyStatusIsFor(status, expect)` is the same check.

`requestInvoice` takes `amountSat` plus an optional `comment`. It also accepts `paymentOption`, except on a session payRequest that does not advertise options (a live session's); a nameless receiver's session LNURL advertises them. The amount is range-checked locally before anything hits the wire.

To pay in one of the payRequest's `units` instead, pass `{ unit, amount }` in place of `amountSat`, with `amount` in the unit's smallest denomination: `{ unit: "USD", amount: 500 }` is $5.00. The receiver quotes it to millisats; the answer must carry a `paymentQuote` for exactly that amount and unit, and a BOLT11 must be for the quoted millisats, or `requestInvoice` throws. `parseUnitAmount("5.00", 2)` and `formatUnitAmount("500", 2)` convert between what a person types and that integer.

The payment router takes the same thing as `unitAmount` beside `raw`: `router.options({ raw: "alice@example.com", unitAmount: { unit: "USD", amount: 500 } })`, or `arkadeLnurl(...).options(target, { unit: "USD", amount: 500 })`. Only the lnurl rails can price it, on whichever of arkade and lightning the target offers; the quote records it as `lnurlQuoteMeta(quote).quote`. Keep that on the `SentPayment` you write as `quote`, and the sent row shows it as `requested`. A received payment synced from a server that records quotes carries the same `quote`, and its row shows `requested` too.

The router quotes only its top-ranked option. To fall back when one lnurl rail cannot quote, filter `router.options(...)` with `isLnurlRail` and hand the rest to `firstQuote(options, onRefused?)`: it returns the first quote, reports each refusal, and throws the last.

**Rails can carry different amounts, so check the option you selected.** A covenant destination is bounded by dust and VTXO shape, a solver-mediated swap by whatever the solver quotes — so an entry in `paymentOptions` may publish its own `minSendable`/`maxSendable`, and those win over the top-level pair when you select it. The top-level pair describes the rail you get by sending no `paymentOption` at all. `requestInvoice` applies that rule for you; apply it yourself if you build the callback URL by hand, or you will reject amounts the rail would have accepted.

### Many pending invoices: verifyBatch

When the callback also returns `verifyBatch` ([LUD-XX, lnurl/luds#299](https://github.com/lnurl/luds/pull/299)), one request covers every pending invoice at that endpoint:

```ts
const { results } = await payer.batchVerify(invoice.verifyBatch, pendingVerifyUrls);
// results[url] is { kind: "verify", status } or { kind: "error", reason }, one per URL you sent

const stream = payer.openVerifyBatchStream(
  { verifyBatchUrl: invoice.verifyBatch, verifyUrls: pendingVerifyUrls },
  { onUpdate: (url, status) => { /* snapshot first, then live settlements */ }, onClose: () => { /* reopen if still pending */ } },
);
stream.update([newVerifyUrl], [settledVerifyUrl]); // grow or shrink the set without reconnecting
```

`batchVerify` splits the set and retries when the server answers `414`/`431`. The stream falls back to the one-shot snapshot when the server does not stream (including a `406`), and closing is final: reopening is the caller's job.

### Token options

A payRequest may offer a token on another chain (an lnurl-server with FixedFloat deposits, say): an option whose `type` is a CAIP-2 namespace, with a CAIP-19 `asset`, a `unit` naming a `units[]` entry, and the `provider` the payer hands the tokens to. Read them with `tokenOptions`, which accepts exactly what the BTCPay LNURLVerify plugin accepts:

```ts
import { tokenOptions } from "@arkade-os/lnurl-client";

for (const option of tokenOptions(payRequest)) {
  const answer = await payer.requestInvoice(payRequest, { amountSat: 10_000, paymentOption: option.id });
  if (answer.kind !== "destination") continue;
  // answer.paymentURI (EIP-681 or Solana Pay; absent on Tron), answer.paymentDestination,
  // answer.paymentQuote.payment = { amount: base units, unit: option.unit.code },
  // answer.paymentQuote.expiresAt = the payer's deadline (ISO 8601)
}
```

`requestInvoice` refuses a token answer for another option, one whose destination is not an address on the token's chain, and one that quotes no whole amount of the token. The amount you request is still sats: what the receiver is paid before the swap's fee.

`chainName(option.asset.chainId)` names the network as the plugin does ("Arbitrum One", "Tron"), or returns the CAIP-2 id for a chain it does not know.

## Receiver

Receiver and management calls need `baseUrl`. `deriveSessionToken` turns a wallet private key and a domain into a stable session token; opening a session with the same token reconnects the same session id.

```ts
import { createLnurlClient, deriveSessionToken } from "@arkade-os/lnurl-client";

const receiver = createLnurlClient({ baseUrl: "https://lnurl.example.com" });
const token = deriveSessionToken("<wallet-private-key-hex>", "example.com");

const session = await receiver.openSession({ token }, {
  onInvoiceRequest: async ({ amountMsat }, respond) => {
    const pr = await makeInvoice(amountMsat); // injected invoice provider: your Lightning node
    await respond.answerInvoice(pr);           // or: await respond.rejectInvoice(reason)
  },
});

// session.lnurl is what payers resolve. Once your node reports the invoice settled:
await session.reportSettled("<preimage-hex>");
session.close();
```

### Deriving the token without handing over your key

A library should not need your private key, so there are two ways to derive the token and **they produce the same value** — a wallet can move between them without losing its addresses:

```ts
import { deriveSessionToken, deriveSessionTokenWithSigner } from '@arkade-os/lnurl-client'

// Preferred: the key never leaves the wallet.
const token = await deriveSessionTokenWithSigner(
  (msg, type) => identity.signMessage(msg, type),   // @arkade-os/ts-sdk Identity
  'example.com',
)

// Equivalent, for callers that already hold raw key material:
const same = deriveSessionToken('<private-key-hex>', 'example.com')
```

They agree because the token is `sha256` of a **deterministic ECDSA signature** over `sha256("lnurl-session:<domain>")` — a pure function of key and message — and `deriveSessionToken` simply performs that signature itself.

**It must be ECDSA, and the function passes the type for you.** BIP-340 schnorr is randomised unless given an explicit aux, which `Identity.signMessage` does not expose — and schnorr is its *default*. A schnorr signature is also 64 bytes, exactly like compact ECDSA, so nothing about the returned bytes reveals the mistake; it would simply mint a new token on every call and silently orphan the address. `deriveSessionTokenWithSigner` therefore signs twice and throws if the results differ, rather than trusting the wiring.

**The token is per-domain, and that is a security property, not bookkeeping.** It is a bearer credential: the server receives it and stores it (encrypted, but a server it is stored on can read it). Were it derived from the private key alone, the same credential would authenticate its holder at *every* lnurl-server the user has ever used — so one malicious or breached server could call `registerArkadeIdentity` on a different server and repoint the victim's receive address, which the covenant would then faithfully pay. Binding the domain into the derivation makes a token minted for `example.com` useless at `other.com`.

Two consequences worth planning for:

- A wallet using several servers holds **several tokens**, one per domain. Derive per domain rather than caching one.
- The server cannot enforce this — it sees an opaque token and cannot tell which domain produced it — so the protection holds only for clients that derive this way.

Derive the token from wallet key material rather than generating a random one you then have to persist: losing it loses the address, since the server identifies the owner by `sha256` of the token bytes and has no other record of who you are.

`deriveSessionId(token)` computes that session id locally — the same value the server derives — which is useful for asserting a reconnect resumed the session you expected rather than trusting the id echoed back to you.

## Validating input

Exported standalone, because a UI validates what a user pasted or scanned before it has a client or a `baseUrl`:

```ts
import { isValidLnUrl, isLnAddress, isLnUrl, toPayRequestUrl } from '@arkade-os/lnurl-client'

isValidLnUrl('alice@example.com')   // true  — either form
isValidLnUrl('LNURL1DP68…')         // true
isValidLnUrl('not an lnurl')        // false

toPayRequestUrl('alice@example.com')
// → { url: 'https://example.com/.well-known/lnurlp/alice', surface: 'address' }
```

`isLnAddress` and `isLnUrl` test one form each; `isValidLnUrl` accepts either. All are shape checks only — they never touch the network, so a well-formed but unregistered address passes here and fails at `resolve`.

`toPayRequestUrl` also reports the **surface**. A live `session` LNURL takes an amount and a comment and nothing else, so `requestInvoice` rejects rail options on a session payRequest that advertises none, rather than letting the server ignore them silently. A nameless receiver's session LNURL serves its address, `paymentOptions` and units included, and is paid like one.

Mixed-case LNURLs are rejected per BIP-173 — bech32 forbids mixed case so that case-mangling in transit cannot slip past the checksum. All-uppercase, which is what QR codes carry, decodes normally.

## Lightning addresses

A LUD-16 address (`alice@example.com`) is payable whether or not the wallet is online. Registering one is what unlocks the offline rails — without it a payer can only reach a live session.

**The token is the credential for everything here.** The server derives the address's owner from it (`sha256` of the token bytes), so the same token that opens a session also owns the addresses registered with it. Losing it loses the address; leaking it hands someone else control of where payments go. Derive it from wallet key material with `deriveSessionToken` rather than generating a fresh random one you then have to store.

All calls in this section need `baseUrl`.

```ts
import { createLnurlClient, deriveSessionToken } from '@arkade-os/lnurl-client'

const client = createLnurlClient({ baseUrl: 'https://lnurl.example.com' })
// Per-domain: this token authenticates at example.com and nowhere else.
const token = deriveSessionToken('<wallet-private-key-hex>', 'example.com')

const address = await client.registerAddress({ token, username: 'alice' })
// → { lightningAddress: 'alice@example.com', lnurl: 'LNURL1…', username, domain, status }

const mine = await client.listAddresses(token)
// → [{ username, domain, status, createdAt, lightningAddress, lnurl }]

await client.revokeAddress(token, 'alice')
```

`username` is optional — omit it and the server allocates one, subject to the domain's policy. Some domains require an API key to register; pass it as `apiKey` and it is sent as `X-API-Key`. Both `revokeAddress` and `registerArkadeIdentity` take an optional `domain` when the server hosts several.

### Offline receive

Binding an Arkade identity to an address is what lets payments arrive while the wallet is closed — the server takes a solver-mediated swap or a covenant destination on its behalf, and the funds are constrained to pay only the address you register here.

```ts
await client.registerArkadeIdentity({
  token,
  username: 'alice',
  arkadeAddress: 'ark1…',
  claimPublicKey: '02…',      // compressed 33-byte key, validated locally
  boardingAddress: 'bc1…',    // optional: adds the onchain rail
})
```

**Call it again to update it.** The server overwrites, so re-registering is how you point an address at a new Arkade address or claim key; there is no separate update call.

`boardingAddress` is the one exception to that overwrite: register it and the address advertises an `onchain` payment option paying it, omit it and an already-registered one is left alone — so a later identity update does not silently withdraw the rail. It is sent unvalidated, unlike `claimPublicKey`, because it is an ordinary Bitcoin address on whatever network the operator runs and this package cannot know which. Payers get no `verify` URL on that rail: nothing server-side observes Bitcoin, so those payments never settle there and a URL could only ever answer "not yet".

### With the Arkade SDK

The main entry point stays free of `@arkade-os/sdk`, because the payer half of this package has nothing to do with Arkade and a checkout page should not pull the SDK and its Expo peers to ask an address for an invoice. A receiver already has the SDK, so the Arkade-aware helpers live behind a subpath with the SDK as an **optional peer dependency**:

```ts
import { arkadeIdentityRequest, deriveSessionTokenForIdentity } from '@arkade-os/lnurl-client/arkade'

// The key never leaves the wallet, and ECDSA is chosen for you.
const token = await deriveSessionTokenForIdentity(identity, 'example.com')

// Validates the Arkade address and derives claimPublicKey from the identity.
// boardingAddress is optional here too, and passed through unchecked.
await client.registerArkadeIdentity(
  await arkadeIdentityRequest({ identity, arkadeAddress, token, username: 'alice' }),
)
```

Three things this buys over doing it by hand:

- **`isArkadeAddress` decodes locally.** Without the SDK a malformed address is only caught server-side, a round trip later.
- **`deriveSessionTokenForIdentity` pins ECDSA.** Schnorr is `Identity.signMessage`'s default and is randomised, which would mint a fresh token on every call and orphan the address — and a schnorr signature is 64 bytes exactly like compact ECDSA, so nothing about the bytes reveals the mistake.
- **`claimPublicKeyOf` derives the compressed key** in the form the server validates, instead of leaving the caller to extract and hex-encode it.

Not yet covered: verifying on-chain that a settled destination payment actually paid the registered address. `StoredPayment` carries `paymentReference` and `covenantScript` for exactly that check, but performing it needs an indexer and is not implemented here — a consumer still trusts the server's word that a payment happened.

### Payment activity

`listPayments` is a sync source, not just a list: it exists so a wallet that was offline can recover receives it never witnessed, which for the offline rails is every one of them.

`syncPayments` drives it for you across every address you hold — paging, cursors, retry and per-server isolation — writing through a store you supply:

```ts
import { createLnurlClient, syncPayments } from '@arkade-os/lnurl-client'

const { synced, failures } = await syncPayments(
  [{ baseUrl: 'https://lnurl.example.com', token, username: 'alice', domain: 'example.com' }],
  { client: (baseUrl) => createLnurlClient({ baseUrl }), store: myStore },
)
```

Pass `signal` to stop early: once it aborts, no further page is fetched and nothing more is written, and the abort is not reported as a failure. `receiver.sync({ signal })` forwards it.

**`browserPaymentStore()` is a small localStorage demo store**: synchronous, a few megabytes, and it rewrites every record per upsert. Browser apps can instead use the optional `/browser` IndexedDB backend described below. Node and React Native supply their own persistence through the same injection the package uses for `fetchImpl`:

```ts
interface PaymentSyncStore {
  upsert(records: StoredPayment[]): Promise<void>  // keyed by record.key; overwrite, never append
  readWatermark(baseUrl: string, lightningAddress: string): Promise<number | undefined>
  writeWatermark(baseUrl: string, lightningAddress: string, since: number): Promise<void>  // may move backwards; store verbatim
}
```

`client` is a factory, not a client, because a client is pinned to one `baseUrl`. Sharing one across targets would send every target's bearer token to whichever server that client was built for.

A target that fails lands in `failures` while the others keep syncing, and its watermark stays put — so a transient outage cannot silently skip the payments that arrived during it.

These matter for correctness. `syncPayments` handles them all; you must handle them yourself if you drive `listPayments` directly:

- **`page.source`** carries `{ domain, lightningAddress }`. Store it with each entry: a wallet holding addresses on several servers needs it to attribute them, and the deduplication key is `(baseUrl, identifier)` — identifiers are unique per server, not globally.
- **`nextSince` is inclusive**, so the boundary row comes back on the next sync. Upsert rather than insert. An exclusive cursor would silently drop payments sharing a millisecond, which is why it works this way.
- **A creation-ordered cursor cannot track settlement.** `settled` mutates long after a row is created, so a cursor parked at the newest `createdAt` never re-reads an older row that settles later — the wallet shows it pending forever. The server now pages on `updatedAt`, which lists a row again whenever it changes, but older servers page on `createdAt`. For those, `syncPayments` persists the oldest row still waiting to settle instead, and reaches at most one page back so a row nothing will ever settle — an `onchain` destination, which nothing server-side watches, or an invoice nobody paid — costs one extra page per sync rather than re-paging your whole history.
- **Switch on `kind`, never on the presence of a payment hash.** On the arkade rail the server's own record has no payment hash — the identifier is an opaque verify id — which is why `DestinationActivity` calls it `verifyId` and has no `paymentHash` property at all.
- **A full page need not advance the cursor.** `nextSince` is the last row's `updatedAt` (`createdAt` on older servers), so if a whole page shares one millisecond the next request returns that same page. Stop and report rather than loop; `syncPayments` fails that target with a terminal `LnurlError`.

### Activity resolvers

`@arkade-os/lnurl-client/arkade` also exports `lnurlActivityResolver(payments)` and `sentActivityResolver(sends)`, `ActivityResolver`s that label an `ArkTransaction` with the LNURL payment or send it corresponds to. Each awaits its getter, sync or async, on every `prepare()`, so a database-backed receive store passes `() => repository.all()` as is and a sync written after construction still shows. `lnurlActivity(activity)` reads a tagged row back typed: `{ direction, address?, rail? }`, where `address` is the counterparty for a send and the receiving address for a receive. `LNURL_ACTIVITY_KIND` and `SENT_ACTIVITY_KIND` name the kinds the resolvers set.

### Shared persistence and send tracking

`createLnurlPaymentRepository(payments, watermarks)` provides the write gate and reset ordering over injected backends. It implements `PaymentSyncStore`, so pass it directly as `arkadeLnurl`'s or `syncPayments`'s `store`. Each wallet instance needs its own repository.

```ts
import { createLnurlPaymentRepository, clearLnurlPaymentsForReset } from '@arkade-os/lnurl-client'

const repository = createLnurlPaymentRepository(
  {
    read: () => paymentDb.readAll(),
    write: (records) => paymentDb.upsert(records),
    clear: () => paymentDb.clear(),
  },
  {
    read: (baseUrl, address) => cursorDb.read(baseUrl, address),
    write: (baseUrl, address, since) => cursorDb.write(baseUrl, address, since),
    clear: () => cursorDb.clear(),
  },
)
```

The record backend must upsert by `key` and resolve writes only after commit. Cursor values are inclusive and may move backwards; store them exactly. All writes must go through the repository for its gate to cover them. Keep each backend scoped to the wallet's LNURL data.

Before clearing other wallet data, stop the app's sync producers and call `await clearLnurlPaymentsForReset(repository)`. This closes admission synchronously, waits for accepted record and cursor writes, then clears cursors followed by records. A late writer is ignored. Failure rejects and reopens admission so the app can abandon reset; success leaves writes closed until a new wallet repository is created. The two backends are not cleared atomically: if clearing records fails, cursors have already been removed, allowing the next sync to replay safely. An explicit `repository.clear()` purges both backends without closing admission; use the reset helper when writers may still be active.

`createPendingConfirmations(client?)` shares a batch request per advertised endpoint and falls back to `pollVerify` without one. Pass the quote's `expect` to bind a response to the intended payment. Each registration accepts `startedAt` in milliseconds and optional `timeoutMs` (default 180,000); resuming retains the original deadline. Registrations deduplicate by optional `key`, defaulting to `verifyUrl`. Use distinct keys when separate sends share a verify URL. `forget()` aborts active work and suppresses its later callbacks. The demo wallet uses this factory too.

`createLnurlSendTracker` from `/arkade` records funding and later settlement updates, merges by transaction id, and resumes unfinished receiver confirmations:

```ts
import { createLnurlSendTracker, sentActivityResolver } from '@arkade-os/lnurl-client/arkade'

const sends = createLnurlSendTracker({
  read: () => sentStore.read(),
  write: (records) => sentStore.write(records),
}, { onError: showStorageError })
wallet.activity.use(sentActivityResolver(sends.all))
sends.resume()

const handle = await quote.send()
sends.record(handle, quote, target)
// Once a funding txid is known, start its receiver confirmation.
sends.watch(txid, verifyUrl, verifyBatch, startedAt, expect)
```

The send backend reads and writes synchronously. Supply `onError` to surface persistence failures from payment or confirmation callbacks; SDK payment handles otherwise swallow subscriber exceptions. An optional `confirmations` in the same options object injects a shared tracker. `record()` returns an unsubscribe function and releases subscriptions on settlement or failure. It retains the quote's verify URLs, expected payment identity, and unit amount alongside later preimages. `resume()` watches only rows without a recorded confirmation outcome. `mark(txid, confirmed)` updates an existing row; `all()` reads the stored sends.

Call `sends.forget()` before clearing its backend on reset: it unsubscribes payment handles and suppresses stale confirmation callbacks, so an old wallet cannot write a preimage into the next wallet's records. It does not delete records; clearing the app's send backend remains the app's responsibility.

In a browser, `createLocalStorageLnurlSentPaymentStore(key?)` from `/browser` is a ready send backend: one JSON array under `key`, where unreadable or non-array data reads as no sends and is left as it is. `sends.subscribe(listener)` is called after each write that landed, never after one that failed, so an open receipt can refresh when its confirmation arrives; it returns the unsubscribe.

### Token quotes

For selected token options, `requestInvoice` now keeps a supplied `paymentURI` only when it pays the quoted token, chain, recipient and amount. A malformed, unsupported or mismatched URI falls back to the validated deposit address; an absent URI remains absent. EIP-681 transfers reject ambiguous or extra transfer arguments, and Solana Pay transfers bind any required memo. The result still carries `paymentDestinationTag`: an app that cannot present or carry it must refuse that deposit.

```ts
import { normalizeTokenQuote, tokenOptions } from '@arkade-os/lnurl-client'

const token = tokenOptions(payRequest).find((option) => option.id === selectedId)!
const answer = await client.requestInvoice(payRequest, { amountSat, paymentOption: token.id })
if (answer.kind !== 'destination') throw new Error('Expected a token destination')
const quote = normalizeTokenQuote(token, answer)
// quote.value, destination, baseUnits, amount, expiresAt, paymentDestinationTag
```

`normalizeTokenQuote` requires a valid future `paymentQuote.expiresAt` and formats base units exactly through 36 decimals without floating-point conversion. `payableTokenUri(token, answer)` performs the same payment binding without requiring expiry. Existing `requestInvoice` callers retain control over optional expiry handling. `requestTokenQuote(payRequest, token, amountSat, { minLifetimeMs, client })` does the request, the destination check and normalization in one call, and refuses a quote with less than `minLifetimeMs` left. `tokenOptionAccepts(token, payRequest, amountSat)` applies the option's own bounds, else the payRequest's. Fiat-price tolerance, memo handling, expiry timers and explicit regeneration remain app policy; no helper places another order unasked.

### Receive rails and startup

```ts
import { bootstrapReceiver, claimOrAdopt, lnurlRailLimits, resolveLnurlRails } from '@arkade-os/lnurl-client/arkade'

const boot = await bootstrapReceiver(facade, { autoClaimNameless: true, refresh: true, signal })
if (boot.kind === 'ready') {
  const limits = lnurlRailLimits(await boot.receiver.payRequest())
  const targets = await resolveLnurlRails(boot.receiver, amountSat,
    ['lightning', 'arkade', 'onchain'], { arkade: ownArkade, onchain: ownBoarding }, client)
}
const receiver = await claimOrAdopt(facade, { username: chosenName })
```

Bootstrap discovers an owned receiver first. Named receivers need no capabilities request; a nameless receiver remains usable if naming capabilities cannot be fetched, with the error returned as `capabilitiesError`. Only a successful empty ownership lookup can lead to onboarding. Nameless allocation defaults off and requires explicit opt-in, the advertised `session` mode, and no API-key requirement. A newly allocated result carries `claimed: true`; the app decides whether to sync afterwards. `refresh` and `signal` go to `owned`, and `signal` to the nameless claim too.

`claimOrAdopt` returns an owned receiver or claims with the supplied options; lookup errors propagate without allocation. The demo wallet uses these startup helpers. UI choice ordering and translated errors stay with the app.

`lnurlRailLimits` converts each enabled Bitcoin option's millisat bounds to whole sats and excludes token options. For a payer, `lnurlPayableRanges(payRequest, types?)` keeps the ranges on `types` (arkade and lightning by default) that still hold a whole sat, and returns `{ ranges, min, max, fixed, accepts(sats) }`; `accepts` rejects an amount in a gap between ranges. `resolveLnurlRails` returns an ordered `Promise.allSettled` result, validates option availability, bounds and response identity, and checks returned payment kinds. Legacy Lightning fallback applies only when `paymentOptions` is absent. Onchain targets must equal the supplied boarding address; Arkade targets must share the supplied address's network and operator. That operator check does not prove recipient ownership: covenant-derived destinations may differ from the static address. An optional injected client controls callback transport. The demo uses the bounds helper when offering receive options.

### IndexedDB backend

```ts
import { createIndexedDbLnurlPaymentStore, createLocalStorageLnurlWatermarkStore } from '@arkade-os/lnurl-client/browser'
import { createLnurlPaymentRepository } from '@arkade-os/lnurl-client'

const repository = createLnurlPaymentRepository(
  createIndexedDbLnurlPaymentStore(),
  createLocalStorageLnurlWatermarkStore(),
)
```

The optional browser entry point touches IndexedDB only when a store operation runs. Defaults preserve the wallet backend's `arkade-lnurl-payments` database, version 1, `payments` store and `key` key path; custom database/store names are accepted. Writes resolve after commit, an aborted transaction rejects, and a synchronous failure while queuing a batch aborts its earlier writes. Every opened operation closes its connection on completion or failure. Neither adapter migrates nor deletes an existing schema.

`createLocalStorageLnurlWatermarkStore(key?)` keeps the cursors as one JSON map under `key` (default `arkade-lnurl.watermarks`), keyed `${baseUrl}|${lightningAddress}`. A map it cannot read, or a cursor that is not a number, counts as absent, so the next sync replays rather than skips; a refused write rejects, and `syncPayments` reports it as that target's failure.

## Errors

Two shapes, both surfaced as `LnurlError`:

- LUD-06 endpoints answer HTTP 200 carrying `{ status: "ERROR", reason }`.
- Management endpoints answer a real status code carrying `{ error, code? }` (for example 409 with `taken`). `LnurlAddressErrorCode` lists the codes the address endpoints use.
- Rate limits mix the two: HTTP 429 with the `{ status: "ERROR" }` body.

`LnurlError` carries `reason`, optional `httpStatus` and `code`, and `retryable`, which is true if and only if `httpStatus === 429`. Everything else is terminal - do not retry it into a different answer.

`LnurlTransportError` means the request or the stream itself failed (network down, unreadable SSE body). `LnurlTimeoutError` means `pollVerify` ran past `timeoutMs`; its `lastSnapshot` holds the last verify status seen.

## Transport

The receiver session is POST-SSE over `fetch`: `openSession` POSTs a JSON body to `/lnurl/session` and reads the event stream from `response.body`.

**It is not `EventSource`, and cannot be.** `EventSource` is GET-only and carries neither a request body nor headers, while this protocol needs both — the session token goes in the POST body, and the invoice and settled calls are Bearer-authed. That is a property of the server's endpoint rather than a choice this package makes. The practical cost is that reconnect and backoff are implemented here instead of inherited from the platform.

The only requirement is therefore a `fetch` whose `Response` exposes a readable `response.body`. `openSession` throws `LnurlTransportError` immediately when it does not, rather than hanging.

### React Native / Expo

React Native's global `fetch` does **not** expose a readable `response.body`, so inject [`expo/fetch`](https://docs.expo.dev/versions/latest/sdk/expo/#fetch), which does. This is the same approach `@arkade-os/ts-sdk` takes for its own SSE streams.

```ts
import { fetch as expoFetch } from 'expo/fetch'
import { createLnurlClient } from '@arkade-os/lnurl-client'

const client = createLnurlClient({
  baseUrl: 'https://lnurl.example.com',
  fetchImpl: expoFetch,
})
```

No cast is needed: `FetchImpl` is a structural signature — `(input: string, init?: RequestInit) => Promise<Response>` — rather than `typeof globalThis.fetch`, so any conforming implementation is assignable. The same seam takes an instrumented fetch, one that adds headers, or a test double:

```ts
const client = createLnurlClient({
  baseUrl: 'https://lnurl.example.com',
  fetchImpl: (url, init) =>
    fetch(url, { ...init, headers: { ...init?.headers, 'X-App': 'wallet' } }),
})
```

Passing nothing resolves `globalThis.fetch` **per call** rather than binding it once, so a client constructed at module scope still picks up a fetch installed later — a mock in a test, a polyfill, or a service worker.

The payer surface (`resolve`, `requestInvoice`, `pollVerify`) is plain request/response and works anywhere `fetch` exists, streaming or not.
