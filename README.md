# @arkade-os/lnurl

LNURL service that enables amountless Lightning receives for Arkade wallets. When a wallet wants to receive via Lightning without specifying an amount upfront, it opens an SSE session with this service and gets back an LNURL. When a payer scans the LNURL and chooses an amount, the service notifies the wallet to create a swap and returns the resulting bolt11 invoice to the payer.

## Flow

```
Wallet                    Service                     Payer
  │                          │                          │
  │── POST /lnurl/session ──▶│                          │
  │◀── SSE: session_created ─│                          │
  │    { sessionId, lnurl }  │                          │
  │                          │◀── GET /lnurl/:id ───────│
  │                          │── payRequest metadata ───▶│
  │                          │                          │
  │                          │◀── GET /lnurl/:id/cb ────│
  │                          │    ?amount=50000         │
  │◀── SSE: invoice_request ─│    (holds response)      │
  │    { amountMsat }        │                          │
  │                          │                          │
  │── POST /session/:id/ ───▶│                          │
  │   invoice { pr: "lnbc…" }│── { pr: "lnbc…" } ─────▶│
  │                          │                          │
  │── (close SSE) ──────────▶│  LNURL deactivated       │
```

## Endpoints

| Method | Path | Caller | Purpose |
|--------|------|--------|---------|
| POST | `/lnurl/session` | Wallet | Opens SSE stream, returns `session_created` event with `sessionId` and `lnurl` |
| GET | `/lnurl/:id` | Payer | LNURL-pay first call ([LUD-06](https://github.com/lnurl/luds/blob/luds/06.md)) — returns min/max amounts and metadata |
| GET | `/lnurl/:id/callback?amount=<msat>` | Payer | Requests invoice — notifies wallet via SSE, holds response until wallet replies |
| POST | `/lnurl/session/:id/invoice` | Wallet | Wallet posts `{ pr: "<bolt11>" }` to resolve the pending payer request |

## Usage

### As a library

```ts
import { createServer } from "@arkade-os/lnurl";

const app = createServer({
  port: 3000,
  baseUrl: "https://lnurl.example.com",
  minSendable: 1_000,        // 1 sat in millisats
  maxSendable: 100_000_000,  // 100k sats in millisats
  invoiceTimeoutMs: 30_000,
});

app.listen(3000);
```

### Standalone

```bash
PORT=3000 \
BASE_URL=https://lnurl.example.com \
MIN_SENDABLE=1000 \
MAX_SENDABLE=100000000000 \
INVOICE_TIMEOUT_MS=30000 \
pnpm dev
```

### Docker

```bash
docker build -t arkade-lnurl .
docker run -p 3000:3000 \
  -e BASE_URL=https://lnurl.example.com \
  arkade-lnurl
```

## Wallet Integration

1. **Open session** — `POST /lnurl/session`. The response is an SSE stream. The first event is `session_created` with `{ sessionId, lnurl }`. Display the LNURL as a QR code.

2. **Listen for invoice requests** — When the payer scans and selects an amount, the wallet receives an `invoice_request` event with `{ amountMsat, comment }`.

3. **Create swap and reply** — Use `@arkade-os/boltz-swap` to create a reverse swap for the requested amount, then `POST /lnurl/session/:id/invoice` with `{ pr: "<bolt11>" }`.

4. **Close session** — When done, close the SSE connection. The LNURL is immediately deactivated.

## SSE Events

| Event | Data | Description |
|-------|------|-------------|
| `session_created` | `{ sessionId, lnurl }` | Session is active, LNURL is ready to share |
| `invoice_request` | `{ amountMsat, comment? }` | Payer requested an invoice for this amount |
| `error` | `{ message }` | Something went wrong |

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `3000` | Server port |
| `BASE_URL` | `http://localhost:3000` | Public URL for generating LNURLs |
| `MIN_SENDABLE` | `1000` | Minimum amount in millisats |
| `MAX_SENDABLE` | `100000000000` | Maximum amount in millisats |
| `INVOICE_TIMEOUT_MS` | `30000` | How long to wait for wallet to provide bolt11 |

## Development

```bash
pnpm install
pnpm test        # run tests
pnpm dev         # start with hot reload
pnpm build       # build for production
pnpm type-check  # typecheck without emitting
```
