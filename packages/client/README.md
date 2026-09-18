# @arkade-os/lnurl-client

Full-duplex client for the lnurl-server protocol: payer (`resolve`, `requestInvoice`, `pollVerify`) and receiver (sessions, settled reporting, address and Arkade-identity registration).

## Install

```sh
pnpm add @arkade-os/lnurl-client
```

Runtime dependencies are `@scure/base` and `@noble/hashes` - nothing else is pulled in, and the package never imports the server, so app bundles stay free of `express` and `sqlite`.

## Payer

`createLnurlClient()` with no `baseUrl` covers payer-only use: `resolve`, `requestInvoice` and `pollVerify` talk to whatever host the address or LNURL points at.

```ts
import { createLnurlClient } from "@arkade-os/lnurl-client";

const payer = createLnurlClient();

const payRequest = await payer.resolve("alice@example.com"); // or an lnurl bech32 string
const invoice = await payer.requestInvoice(payRequest, { amountSat: 50 });

// Pay invoice.pr through your own Lightning path, then wait for settlement:
if (invoice.kind === "bolt11" && invoice.verify) {
  const status = await payer.pollVerify(invoice.verify, { timeoutMs: 120_000, intervalMs: 1_000 });
  if (status.kind === "bolt11" && status.settled) {
    console.log("settled, preimage:", status.preimage);
  }
}
```

`requestInvoice` takes `amountSat` plus an optional `comment`. On an address payRequest it also accepts `paymentOption` and `unit`; on a session payRequest those two are rejected. The amount is range-checked locally before anything hits the wire.

**Rails can carry different amounts, so check the option you selected.** A covenant destination is bounded by dust and VTXO shape, a solver-mediated swap by whatever the solver quotes — so an entry in `paymentOptions` may publish its own `minSendable`/`maxSendable`, and those win over the top-level pair when you select it. The top-level pair describes the rail you get by sending no `paymentOption` at all. `requestInvoice` applies that rule for you; apply it yourself if you build the callback URL by hand, or you will reject amounts the rail would have accepted.

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

`toPayRequestUrl` also reports the **surface**, which decides what the payRequest supports: `paymentOptions`, units and the offline rails exist only on the `address` surface, while a `session` LNURL takes an amount and a comment and nothing else. `requestInvoice` rejects rail options on a session payRequest rather than letting the server ignore them silently.

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
  claimPublicKey: '02…',   // compressed 33-byte key, validated locally
})
```

**Call it again to update it.** The server overwrites, so re-registering is how you point an address at a new Arkade address or claim key; there is no separate update call.

### With the Arkade SDK

The main entry point stays free of `@arkade-os/sdk`, because the payer half of this package has nothing to do with Arkade and a checkout page should not pull the SDK and its Expo peers to ask an address for an invoice. A receiver already has the SDK, so the Arkade-aware helpers live behind a subpath with the SDK as an **optional peer dependency**:

```ts
import { arkadeIdentityRequest, deriveSessionTokenForIdentity } from '@arkade-os/lnurl-client/arkade'

// The key never leaves the wallet, and ECDSA is chosen for you.
const token = await deriveSessionTokenForIdentity(identity, 'example.com')

// Validates the Arkade address and derives claimPublicKey from the identity.
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

**The package ships no storage implementation.** IndexedDB does not exist in Node or React Native, so you supply the store — the same injection the package uses for `fetchImpl`:

```ts
interface PaymentSyncStore {
  upsert(records: StoredPayment[]): Promise<void>  // keyed by record.key; overwrite, never append
  readWatermark(baseUrl: string, lightningAddress: string): Promise<number | undefined>
  writeWatermark(baseUrl: string, lightningAddress: string, since: number): Promise<void>
}
```

`client` is a factory, not a client, because a client is pinned to one `baseUrl`. Sharing one across targets would send every target's bearer token to whichever server that client was built for.

A target that fails lands in `failures` while the others keep syncing, and its watermark stays put — so a transient outage cannot silently skip the payments that arrived during it.

Three things that matter for correctness. `syncPayments` handles all three; you must handle them yourself if you drive `listPayments` directly:

- **`page.source`** carries `{ domain, lightningAddress }`. Store it with each entry: a wallet holding addresses on several servers needs it to attribute them, and the deduplication key is `(baseUrl, identifier)` — identifiers are unique per server, not globally.
- **`nextSince` is inclusive**, so the boundary row comes back on the next sync. Upsert rather than insert. An exclusive cursor would silently drop payments sharing a millisecond, which is why it works this way.
- **Switch on `kind`, never on the presence of a payment hash.** On the arkade rail the server's own record has no payment hash — the identifier is an opaque verify id — which is why `DestinationActivity` calls it `verifyId` and has no `paymentHash` property at all.
- **A full page need not advance the cursor.** `nextSince` is the last row's `createdAt`, so if a whole page shares one millisecond the next request returns that same page. Stop and report rather than loop; `syncPayments` fails that target with a terminal `LnurlError`.

## Errors

Two shapes, both surfaced as `LnurlError`:

- LUD-06 endpoints answer HTTP 200 carrying `{ status: "ERROR", reason }`.
- Management endpoints answer a real status code carrying `{ error, code? }` (for example 409 with `USERNAME_TAKEN`).
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
