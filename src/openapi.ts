import { VERSION } from "./version.js";

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "LNURL Server",
    description:
      "SSE-based LNURL service for amountless Lightning receives. " +
      "Wallets open an SSE session to get an LNURL, and payers use " +
      "standard LNURL-pay (LUD-06) to request invoices. The wallet " +
      "creates reverse swaps on-the-fly and returns bolt11 invoices. " +
      "When persistence is enabled, wallets can also register " +
      "Lightning Addresses (LUD-16) served from the `.well-known` routes.",
    version: VERSION,
    license: { name: "MIT" },
  },
  servers: [{ url: "/" }],
  paths: {
    "/livez": {
      get: {
        summary: "Liveness probe",
        description:
          "Process liveness for orchestrators: 200 while the process is running. " +
          "It makes no statement about dependencies — use `/readyz` for that.",
        tags: ["Health"],
        responses: {
          "200": {
            description: "Process is live",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string", enum: ["live"] } },
                  required: ["status"],
                },
              },
            },
          },
        },
      },
    },
    "/readyz": {
      get: {
        summary: "Readiness probe",
        description:
          "Reports whether the process is accepting traffic and every registered dependency " +
          "check passes. Returns 503 (with the same body) when a component is not ok or the " +
          "process has begun shutting down.",
        tags: ["Health"],
        responses: {
          "200": {
            description: "Ready — all registered components report ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/HealthSnapshot" } } },
          },
          "503": {
            description: "Unready — a component reported not ok, or the process is shutting down",
            content: { "application/json": { schema: { $ref: "#/components/schemas/HealthSnapshot" } } },
          },
        },
      },
    },
    "/lnurl/session": {
      post: {
        summary: "Open LNURL session",
        description:
          "Opens an SSE stream (`event: <type>` + `data: <json>`). The first event is " +
          "`session_created` with `{ sessionId, lnurl, token }`. Each `invoice_request` " +
          "carries `{ amountMsat, comment? }` when a payer asks for an invoice, and `error` " +
          "carries `{ error }` (e.g. the stream was closed by an operator). Closing the " +
          "stream deactivates the LNURL.",
        tags: ["Session"],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  token: {
                    type: "string",
                    description:
                      "Optional wallet token (hex, ≥32 chars). When sent, the session id is " +
                      "derived from it, so reconnecting with the same token reuses the LNURL; " +
                      "omitted for an ephemeral random session.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "SSE stream opened",
            content: {
              "text/event-stream": {
                schema: { type: "string" },
                example:
                  'event: session_created\ndata: {"sessionId":"abc123","lnurl":"LNURL1...","token":"secret"}\n\n',
              },
            },
          },
          "400": { description: "token must be a hex string of at least 32 characters" },
          "409": { description: "Session ID derived from the token is already in use" },
          "429": { description: "Session limit reached" },
        },
      },
    },
    "/lnurl/session/{id}/invoice": {
      post: {
        summary: "Submit invoice or error",
        description:
          "Wallet posts the bolt11 invoice after creating a swap, " +
          "or an error to reject the payer's request. Requires the " +
          "auth token from the session_created event.",
        tags: ["Session"],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Session ID",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "object",
                    properties: { pr: { type: "string", description: "BOLT11 invoice" } },
                    required: ["pr"],
                  },
                  {
                    type: "object",
                    properties: {
                      error: { type: "string", description: "Rejection reason" },
                    },
                    required: ["error"],
                  },
                ],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Invoice accepted or error acknowledged",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                },
              },
            },
          },
          "401": { description: "Missing or invalid auth token" },
          "400": { description: "Missing pr field" },
          "404": { description: "No pending invoice request" },
        },
      },
    },
    "/lnurl/{id}": {
      get: {
        summary: "LNURL-pay metadata (LUD-06)",
        description:
          "Returns LNURL-pay metadata including min/max amounts " +
          "and the callback URL. Called by the payer's wallet after scanning the LNURL.",
        tags: ["LNURL-pay"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Session ID",
          },
        ],
        responses: {
          "200": {
            description: "LNURL-pay metadata or error",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        tag: { type: "string", enum: ["payRequest"] },
                        callback: { type: "string" },
                        minSendable: { type: "number" },
                        maxSendable: { type: "number" },
                        metadata: { type: "string" },
                        commentAllowed: { type: "number" },
                      },
                    },
                    {
                      type: "object",
                      properties: {
                        status: { type: "string", enum: ["ERROR"] },
                        reason: { type: "string" },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    "/lnurl/{id}/callback": {
      get: {
        summary: "LNURL-pay callback (LUD-06)",
        description:
          "Payer requests an invoice for a specific amount. The server " +
          "notifies the wallet via SSE and holds the response until the " +
          "wallet provides a bolt11 invoice or the request times out.",
        tags: ["LNURL-pay"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Session ID",
          },
          {
            name: "amount",
            in: "query",
            required: true,
            schema: { type: "number" },
            description: "Amount in millisatoshis",
          },
          {
            name: "comment",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Optional payer comment",
          },
        ],
        responses: {
          "200": {
            description: "BOLT11 invoice or error",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        pr: { type: "string", description: "BOLT11 invoice" },
                        routes: { type: "array", items: {} },
                        verify: { type: "string", description: "LUD-21 verify URL (present when the bolt11 could be decoded)" },
                      },
                    },
                    {
                      type: "object",
                      properties: {
                        status: { type: "string", enum: ["ERROR"] },
                        reason: { type: "string" },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    "/lnurl/verify/{paymentHash}": {
      get: {
        summary: "Verify settlement (LUD-21 / LUD-XX)",
        description:
          "Payer polls this to learn whether the invoice settled. Public and unauthed — " +
          "the payment hash is not secret. For lightning, `preimage` is revealed once " +
          "`settled` is true. For a LUD-XX non-`pr` option (e.g. arkade), it reports the " +
          "`paymentOption`, `paymentDestination`, and `paymentReference` instead.",
        tags: ["LNURL-pay"],
        parameters: [
          { name: "paymentHash", in: "path", required: true, schema: { type: "string" }, description: "bolt11 payment hash (hex), or an opaque verify id for non-`pr` options" },
        ],
        responses: {
          "200": {
            description: "Settlement status or error",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        status: { type: "string", enum: ["OK"] },
                        settled: { type: "boolean" },
                        preimage: { type: "string", nullable: true },
                        pr: { type: "string", description: "BOLT11 invoice" },
                      },
                    },
                    {
                      type: "object",
                      description: "LUD-XX non-`pr` option settlement status",
                      properties: {
                        status: { type: "string", enum: ["OK"] },
                        settled: { type: "boolean" },
                        paymentOption: { type: "string" },
                        paymentDestination: { type: "string" },
                        paymentReference: { type: "string", nullable: true, description: "Method-specific reference (e.g. a txid) once observed" },
                      },
                    },
                    {
                      type: "object",
                      properties: {
                        status: { type: "string", enum: ["ERROR"] },
                        reason: { type: "string" },
                      },
                    },
                  ],
                },
              },
            },
          },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/lnurl/session/{id}/settled": {
      post: {
        summary: "Report settlement (LUD-21)",
        description:
          "Wallet reports the preimage once its invoice settles. Authed by the session " +
          "token. The server checks `sha256(preimage)` against a payment hash the session " +
          "issued, then flips the matching verify record to settled.",
        tags: ["Session"],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Session ID" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { preimage: { type: "string", description: "32-byte payment preimage (hex)" } },
                required: ["preimage"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Settlement recorded",
            content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
          },
          "400": { description: "Missing or invalid preimage" },
          "401": { description: "Missing or invalid auth token" },
          "404": { description: "No settlement record for this session matches the preimage" },
        },
      },
    },
    "/lnurl/address": {
      post: {
        summary: "Register or claim an LN address (LUD-16)",
        description:
          "Provisions a Lightning Address bound to the wallet's session token. The " +
          "domain comes from the `domain` body field or the Host header. Behaviour " +
          "follows the domain's allocation policy: send a `username` to self-claim " +
          "(when `self` is allowed), omit it for a random username (when `random` is " +
          "allowed), or send `username` + `claimCode` to claim an admin-reserved one. " +
          "Include `X-API-Key` when the domain requires one.",
        tags: ["LN Address"],
        parameters: [
          {
            name: "X-API-Key",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "Required only when the domain has require-API-key enabled",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  token: { type: "string", description: "Wallet session token (hex, ≥32 chars)" },
                  username: { type: "string", description: "Desired username; omit for random allocation" },
                  claimCode: { type: "string", description: "Claim code for an admin-reserved username" },
                  domain: { type: "string", description: "Target domain (defaults to the Host header)" },
                },
                required: ["token"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Address registered",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    lightningAddress: { type: "string" },
                    lnurl: { type: "string" },
                    username: { type: "string" },
                    domain: { type: "string" },
                    status: { type: "string" },
                  },
                },
              },
            },
          },
          "400": { description: "Missing token, or invalid token/username" },
          "401": { description: "Missing/invalid X-API-Key, or invalid claim code" },
          "403": { description: "Allocation mode not permitted for this domain" },
          "404": { description: "Unknown or disabled domain" },
          "409": { description: "Username already taken or blacklisted" },
          "429": { description: "Rate limited, or per-wallet address limit reached" },
        },
      },
      get: {
        summary: "List your LN addresses",
        description: "Returns the addresses owned by the bearer token.",
        tags: ["LN Address"],
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Owned addresses",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      username: { type: "string" },
                      domain: { type: "string" },
                      status: { type: "string" },
                      createdAt: { type: "number" },
                      lightningAddress: { type: "string" },
                      lnurl: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          "401": { description: "Missing or invalid auth token" },
          "404": { description: "Address provisioning not enabled (no persistence configured)" },
        },
      },
    },
    "/lnurl/address/{username}": {
      delete: {
        summary: "Revoke one of your LN addresses",
        tags: ["LN Address"],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "username", in: "path", required: true, schema: { type: "string" }, description: "Username to revoke" },
          { name: "domain", in: "query", required: false, schema: { type: "string" }, description: "Target domain (defaults to the Host header)" },
        ],
        responses: {
          "200": {
            description: "Address revoked",
            content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
          },
          "401": { description: "Missing or invalid auth token" },
          "404": { description: "Unknown domain, or address not found / not owned by this token" },
        },
      },
    },
    "/lnurl/address/{username}/arkade": {
      post: {
        summary: "Register Arkade receive identity (offline receive)",
        description:
          "Sets the Arkade address + claim public key the server uses to quote a solver-mediated " +
          "corridor swap for this address when the wallet is offline. Requires the owning session token. " +
          "An optional `boardingAddress` registers the `onchain` rail in the same call.",
        tags: ["LN Address"],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "username", in: "path", required: true, schema: { type: "string" }, description: "LN address local part" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  arkadeAddress: { type: "string", description: "Arkade address to receive funds" },
                  claimPublicKey: { type: "string", description: "Compressed claim public key (66 hex chars)" },
                  boardingAddress: {
                    type: "string",
                    description:
                      "Optional Arkade boarding address. Present, the address advertises the `onchain` " +
                      "payment option. Deliberately unvalidated: it is an ordinary Bitcoin address on the " +
                      "operator's network, which this server does not police. Omitting it leaves any " +
                      "existing one alone.",
                  },
                  domain: { type: "string", description: "Target domain (defaults to the Host header)" },
                },
                required: ["arkadeAddress", "claimPublicKey"],
              },
            },
          },
        },
        responses: {
          "200": { description: "Identity stored", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
          "400": { description: "Missing arkadeAddress, a non-compressed/invalid claimPublicKey, or a malformed arkadeAddress" },
          "401": { description: "Missing auth token" },
          "404": { description: "Unknown domain, or address not found / not owned by this token" },
        },
      },
    },
    "/lnurl/address/{username}/payments": {
      get: {
        summary: "List payments received by one of your LN addresses",
        description:
          "Sync source for the owner payment activity, oldest first. " +
          "Pass the returned nextSince back as since to page forward; the cursor is " +
          "inclusive, so the boundary row is re-fetched and deduped on paymentHash.",
        tags: ["LN Address"],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "username", in: "path", required: true, schema: { type: "string" }, description: "LN address local part" },
          { name: "domain", in: "query", required: false, schema: { type: "string" }, description: "Target domain (defaults to the Host header)" },
          { name: "since", in: "query", required: false, schema: { type: "integer" }, description: "Only rows with created_at >= since (ms); absent or non-numeric starts from the beginning" },
          { name: "limit", in: "query", required: false, schema: { type: "integer" }, description: "Max rows returned; default 50, clamped to 1..200" },
        ],
        responses: {
          "200": {
            description: "Payment page, oldest first",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    source: {
                      type: "object",
                      properties: {
                        domain: { type: "string" },
                        lightningAddress: { type: "string" },
                      },
                    },
                    payments: { type: "array", items: { type: "object" } },
                    nextSince: { type: "number" },
                  },
                },
              },
            },
          },
          "401": { description: "Missing auth token" },
          "404": { description: "Unknown or disabled domain, or address not found / not owned by this token" },
        },
      },
    },
    "/.well-known/lnurlp/{username}": {
      get: {
        summary: "LN Address pay metadata (LUD-16)",
        description:
          "LUD-16 well-known endpoint. The Host header selects the domain. Returns " +
          "LNURL-pay metadata for the address, or an error if it is unknown or disabled.",
        tags: ["LN Address"],
        parameters: [
          { name: "username", in: "path", required: true, schema: { type: "string" }, description: "LN address local part" },
        ],
        responses: {
          "200": {
            description: "LNURL-pay metadata or error",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        tag: { type: "string", enum: ["payRequest"] },
                        callback: { type: "string" },
                        minSendable: { type: "number" },
                        maxSendable: { type: "number" },
                        metadata: { type: "string" },
                        commentAllowed: { type: "number" },
                        paymentOptions: {
                          type: "array",
                          description: "LUD-XX: advertised payment rails; present only when a non-lightning rail (e.g. arkade) is offered",
                          items: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              type: { type: "string", description: "e.g. lightning, arkade" },
                              minSendable: {
                                type: "number",
                                description:
                                  "Millisats, present only when this rail's floor differs from the top-level pair — e.g. an Arkade rail bounded by the operator's dust. Absent means the top-level minSendable applies.",
                              },
                              maxSendable: {
                                type: "number",
                                description:
                                  "Millisats, present only when this rail's ceiling differs from the top-level pair. Absent means the top-level maxSendable applies.",
                              },
                            },
                          },
                        },
                        units: {
                          type: "array",
                          description: "LUD-XX: advertised denomination units; present only when a quote provider is configured",
                          items: {
                            type: "object",
                            properties: {
                              code: { type: "string" },
                              decimals: { type: "number" },
                              name: { type: "string" },
                              symbol: { type: "string" },
                              assetId: { type: "string", description: "Asset identifier, when the unit is a non-BTC asset" },
                              minAmount: { type: "string", description: "Smallest quotable amount in the unit's smallest unit" },
                              maxAmount: { type: "string", description: "Largest quotable amount in the unit's smallest unit" },
                            },
                          },
                        },
                      },
                    },
                    {
                      type: "object",
                      properties: {
                        status: { type: "string", enum: ["ERROR"] },
                        reason: { type: "string" },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    "/.well-known/lnurlp/{username}/callback": {
      get: {
        summary: "LN Address pay callback (LUD-16)",
        description:
          "Requests payment for the address. Default (lightning): returns a bolt11 from the " +
          "wallet's SSE session, or a server-created offline reverse swap, or an error when " +
          "offline. LUD-XX: pass `paymentOption` to select an advertised rail — `arkade` " +
          "returns an Arkade destination instead of a bolt11, and `onchain` returns the " +
          "address's registered boarding address. LUD-XX: " +
          "`unit`/`receiveUnit` denominate the amount (requires a configured quote provider); " +
          "the response then includes `paymentQuote`.",
        tags: ["LN Address"],
        parameters: [
          { name: "username", in: "path", required: true, schema: { type: "string" }, description: "LN address local part" },
          { name: "amount", in: "query", required: true, schema: { type: "number" }, description: "Amount — millisatoshis, or the smallest unit of `unit` when set" },
          { name: "comment", in: "query", required: false, schema: { type: "string" }, description: "Optional payer comment" },
          { name: "paymentOption", in: "query", required: false, schema: { type: "string" }, description: "LUD-XX: selected rail id (`arkade`, `onchain`); defaults to lightning" },
          { name: "unit", in: "query", required: false, schema: { type: "string" }, description: "LUD-XX: denomination unit (e.g. `USD`); `amount` becomes that unit's smallest integer" },
          { name: "receiveUnit", in: "query", required: false, schema: { type: "string" }, description: "LUD-XX: desired receiver unit" },
        ],
        responses: {
          "200": {
            description: "BOLT11 invoice, a non-`pr` destination, or error",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        pr: { type: "string", description: "BOLT11 invoice" },
                        routes: { type: "array", items: {} },
                        verify: { type: "string", description: "LUD-21 verify URL (present when the bolt11 could be decoded)" },
                        paymentQuote: {
                          type: "object",
                          description: "LUD-XX quote (present when the request was unit-denominated)",
                          properties: {
                            id: { type: "string" },
                            expiresAt: { type: "string", description: "ISO 8601" },
                            requested: { $ref: "#/components/schemas/AmountObject" },
                            payment: { $ref: "#/components/schemas/AmountObject" },
                            receive: { $ref: "#/components/schemas/AmountObject" },
                            fees: { type: "array", items: { type: "object", properties: { amount: { type: "string" }, unit: { type: "string" }, description: { type: "string" } } } },
                          },
                          required: ["requested", "payment"],
                        },
                        paymentOption: { type: "string", description: "LUD-XX: echoed as `lightning` when the wallet explicitly selected that rail" },
                      },
                      required: ["pr", "routes"],
                    },
                    {
                      type: "object",
                      description: "LUD-XX non-`pr` payment option (e.g. arkade)",
                      properties: {
                        status: { type: "string", enum: ["OK"] },
                        paymentOption: { type: "string" },
                        paymentDestination: { type: "string", description: "Rail destination, e.g. an Arkade address" },
                        expiresAt: {
                          type: "number",
                          description:
                            "Unix seconds after which this server stops attributing payments to this quote. A BOLT11 " +
                            "carries its own expiry and an address carries none, so without this the payer cannot know " +
                            "one exists. NOT a deadline on the money: past it a payment still reaches the destination, " +
                            "and on the covenant rail the sweeper still moves it — what lapses is the record, so verify " +
                            "stops answering and the payment leaves no trace in the address's history. Absent on rails " +
                            "nothing here watches, such as onchain boarding.",
                        },
                        uri: {
                          type: "string",
                          description:
                            "BIP21 URI for the destination carrying the requested amount. The Arkade destination is in " +
                            "`ark=` rather than the address slot, which the scheme reserves for an onchain address; " +
                            "`amount` is BTC per BIP21, though every other amount in this API is millisats.",
                        },
                        verify: {
                          type: "string",
                          description:
                            "LUD-21/LUD-XX verify URL. Present only when the destination identifies the payment — " +
                            "a per-payment covenant address does, a static Arkade address does not, since it is reused " +
                            "for every payment and settles by amount/window correlation. Absent means settlement is not " +
                            "individually attributable, not that it will not settle.",
                        },
                      },
                    },
                    {
                      type: "object",
                      properties: { status: { type: "string", enum: ["ERROR"] }, reason: { type: "string" } },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      AmountObject: {
        type: "object",
        description: "An amount denominated in a unit; strings avoid JSON integer-precision loss",
        properties: { amount: { type: "string" }, unit: { type: "string", description: "e.g. msat, USD" } },
        required: ["amount", "unit"],
      },
      HealthComponent: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          detail: { type: "string", description: "Human-readable explanation of the component state" },
        },
        required: ["ok"],
      },
      HealthSnapshot: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ready", "unready"] },
          components: {
            type: "object",
            description: "One entry per registered dependency check (e.g. persistence, solverDiscovery)",
            additionalProperties: { $ref: "#/components/schemas/HealthComponent" },
          },
          reason: { type: "string", description: "Present once shutdown has begun" },
        },
        required: ["status", "components"],
      },
    },
    securitySchemes: {
      bearerAuth: {
        type: "http" as const,
        scheme: "bearer",
        description: "Token from the session_created SSE event",
      },
    },
  },
};
