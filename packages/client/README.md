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

`requestInvoice` takes `amountSat` plus an optional `comment`. On an address payRequest it also accepts `paymentOption` and `unit`; on a session payRequest those two are rejected. The amount is range-checked locally against `minSendable`/`maxSendable` before anything hits the wire.

## Receiver

Receiver and management calls need `baseUrl`. `deriveSessionToken` turns a wallet private key (hex) into a stable session token; opening a session with the same token reconnects the same session id.

```ts
import { createLnurlClient, deriveSessionToken } from "@arkade-os/lnurl-client";

const receiver = createLnurlClient({ baseUrl: "https://lnurl.example.com" });
const token = deriveSessionToken("<wallet-private-key-hex>");

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

`deriveSessionToken` is byte-compatible with the wallet's existing derivation on purpose: the token derives the session id, which is the ownership key for registered lightning addresses, so changing it would orphan addresses users already hold.

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