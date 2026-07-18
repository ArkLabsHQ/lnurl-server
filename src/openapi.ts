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
    version: "0.2.6",
    license: { name: "MIT" },
  },
  servers: [{ url: "/" }],
  paths: {
    "/lnurl/session": {
      post: {
        summary: "Open LNURL session",
        description:
          "Opens an SSE stream. The first event is `session_created` " +
          "with `{ sessionId, lnurl, token }`. Subsequent `invoice_request` " +
          "events arrive when a payer requests an invoice. Closing the " +
          "stream deactivates the LNURL.",
        tags: ["Session"],
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
          "corridor swap for this address when the wallet is offline. Requires the owning session token.",
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
                  domain: { type: "string", description: "Target domain (defaults to the Host header)" },
                },
                required: ["arkadeAddress", "claimPublicKey"],
              },
            },
          },
        },
        responses: {
          "200": { description: "Identity stored", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
          "400": { description: "Missing arkadeAddress or invalid claimPublicKey" },
          "401": { description: "Missing auth token" },
          "404": { description: "Unknown domain, or address not found / not owned by this token" },
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
          "returns the address's registered Arkade destination instead of a bolt11. LUD-XX: " +
          "`unit`/`receiveUnit` denominate the amount (requires a configured quote provider); " +
          "the response then includes `paymentQuote`.",
        tags: ["LN Address"],
        parameters: [
          { name: "username", in: "path", required: true, schema: { type: "string" }, description: "LN address local part" },
          { name: "amount", in: "query", required: true, schema: { type: "number" }, description: "Amount — millisatoshis, or the smallest unit of `unit` when set" },
          { name: "comment", in: "query", required: false, schema: { type: "string" }, description: "Optional payer comment" },
          { name: "paymentOption", in: "query", required: false, schema: { type: "string" }, description: "LUD-XX: selected rail id (e.g. `arkade`); defaults to lightning" },
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
                      properties: { pr: { type: "string", description: "BOLT11 invoice" }, routes: { type: "array", items: {} }, verify: { type: "string", description: "LUD-21 verify URL (present when the bolt11 could be decoded)" }, paymentQuote: { type: "object", description: "LUD-XX quote (present when the request was unit-denominated)" } },
                    },
                    {
                      type: "object",
                      description: "LUD-XX non-`pr` payment option (e.g. arkade)",
                      properties: {
                        status: { type: "string", enum: ["OK"] },
                        paymentOption: { type: "string" },
                        paymentDestination: { type: "string", description: "Rail destination, e.g. an Arkade address" },
                        verify: { type: "string", description: "LUD-21/LUD-XX verify URL" },
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
    securitySchemes: {
      bearerAuth: {
        type: "http" as const,
        scheme: "bearer",
        description: "Token from the session_created SSE event",
      },
    },
  },
};
