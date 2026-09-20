import { openApiSpec } from "./openapi.js";

// Shorthands for the response shapes used across the admin API.
const OK = {
  "200": {
    description: "Success",
    content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
  },
} as const;

const errorResponse = (status: string, description: string) => ({
  [status]: {
    description,
    content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
  },
});

const idParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "integer" },
  description: "Row id",
} as const;

const Domain = {
  type: "object",
  properties: {
    id: { type: "integer" },
    domain: { type: "string" },
    allocationModes: { type: "array", items: { type: "string", enum: ["self", "random", "admin"] } },
    requireApiKey: { type: "boolean" },
    maxPerSession: { type: "integer", nullable: true },
    usernameMinLen: { type: "integer" },
    usernameMaxLen: { type: "integer" },
    usernamePattern: { type: "string" },
    minSendable: { type: "integer", nullable: true },
    maxSendable: { type: "integer", nullable: true },
    enabled: { type: "boolean" },
    createdAt: { type: "integer" },
    updatedAt: { type: "integer" },
  },
} as const;

const domainBody = {
  type: "object",
  properties: {
    domain: { type: "string", description: "Domain name (lowercased)" },
    allocationModes: { type: "array", items: { type: "string", enum: ["self", "random", "admin"] } },
    requireApiKey: { type: "boolean" },
    enabled: { type: "boolean" },
    maxPerSession: { type: "integer", nullable: true, description: "Max active addresses per wallet; null = unlimited" },
    usernameMinLen: { type: "integer" },
    usernameMaxLen: { type: "integer" },
    usernamePattern: { type: "string", description: "Allowed character class, e.g. a-z0-9._-" },
    minSendable: { type: "integer", nullable: true, description: "Per-domain override (msat); null = use global" },
    maxSendable: { type: "integer", nullable: true },
  },
} as const;

const jsonBody = (schema: object, required = true) => ({
  required,
  content: { "application/json": { schema } },
});

const SolverCard = {
  type: "object",
  properties: {
    id: { type: "integer" },
    label: { type: "string" },
    network: { type: "string" },
    enabled: { type: "boolean" },
    card: { type: "object", description: "The validated solver card as pasted" },
    createdAt: { type: "integer" },
    updatedAt: { type: "integer" },
  },
} as const;

const solverCardMutation = {
  type: "object",
  properties: { persisted: { type: "boolean" }, active: { type: "boolean" }, card: SolverCard },
} as const;

export const adminOpenApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "LNURL Server — Admin API",
    description:
      "Administrative JSON API for the LNURL server. It runs on the **admin port** " +
      "(default 3001), bound to loopback, with **no built-in authentication** — front " +
      "it with a reverse proxy that enforces auth (e.g. basic-auth). Manages domains, " +
      "addresses, API keys, the username blacklist, live wallet sessions, and runtime " +
      "settings. The public LNURL-pay / LN Address API is documented separately on the " +
      "public port.",
    version: openApiSpec.info.version, // single source of truth — bump in openapi.ts
    license: { name: "MIT" },
  },
  servers: [{ url: "/admin/api" }],
  tags: [
    { name: "Domains" },
    { name: "Addresses" },
    { name: "Rails" },
    { name: "API Keys" },
    { name: "Blacklist" },
    { name: "Sessions" },
    { name: "Solver discovery" },
    { name: "Settings" },
  ],
  paths: {
    "/rails": {
      get: {
        summary: "List server-level receive-rail capabilities",
        description: "One entry per rail this process wired (interactive lightning, offline swap, arkade destination, covenant destinations) with its configured/ready state. Per-address policy and effective states ride on the addresses list.",
        tags: ["Rails"],
        responses: {
          "200": {
            description: "Rail capabilities",
            content: { "application/json": { schema: { type: "object", properties: { rails: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, description: { type: "string" }, configured: { type: "boolean" }, ready: { type: "boolean" }, reason: { type: "string", description: "Present when not ready" } } } } } } } },
          },
        },
      },
    },
    "/discovery": {
      get: {
        summary: "Get the active solver discovery snapshot",
        tags: ["Solver discovery"],
        responses: { "200": { description: "Discovery status" }, ...errorResponse("503", "Discovery is disabled") },
      },
    },
    "/discovery/refresh": {
      post: {
        summary: "Refresh registries and pasted cards now",
        tags: ["Solver discovery"],
        responses: { "200": { description: "Refreshed discovery status" }, ...errorResponse("503", "Discovery is disabled") },
      },
    },
    "/solver-cards": {
      get: {
        summary: "List pasted solver cards",
        tags: ["Solver discovery"],
        responses: { "200": { description: "Persisted cards", content: { "application/json": { schema: { type: "array", items: SolverCard } } } } },
      },
      post: {
        summary: "Validate and persist a pasted solver card",
        tags: ["Solver discovery"],
        requestBody: jsonBody({ type: "object", required: ["label", "card"], properties: { label: { type: "string" }, card: { type: "object" } } }),
        responses: {
          "202": { description: "Persisted; active reports whether the refreshed snapshot is usable", content: { "application/json": { schema: solverCardMutation } } },
          ...errorResponse("400", "Invalid solver card"),
        },
      },
    },
    "/solver-cards/{id}": {
      put: {
        summary: "Replace a pasted solver card",
        tags: ["Solver discovery"],
        parameters: [idParam],
        requestBody: jsonBody({ type: "object", required: ["label", "card"], properties: { label: { type: "string" }, card: { type: "object" } } }),
        responses: {
          "202": { description: "Replaced and refreshed", content: { "application/json": { schema: solverCardMutation } } },
          ...errorResponse("400", "Invalid solver card"),
          ...errorResponse("404", "Solver card not found"),
        },
      },
      patch: {
        summary: "Enable or disable a pasted solver card",
        tags: ["Solver discovery"],
        parameters: [idParam],
        requestBody: jsonBody({ type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } }),
        responses: {
          "202": { description: "Updated and refreshed", content: { "application/json": { schema: solverCardMutation } } },
          ...errorResponse("400", "enabled must be boolean"),
          ...errorResponse("404", "Solver card not found"),
        },
      },
      delete: {
        summary: "Delete a pasted solver card",
        tags: ["Solver discovery"],
        parameters: [idParam],
        responses: {
          "202": { description: "Deleted and refreshed", content: { "application/json": { schema: { type: "object", properties: { persisted: { type: "boolean", enum: [false] }, active: { type: "boolean" } } } } } },
          ...errorResponse("404", "Solver card not found"),
        },
      },
    },
    // ── Domains ──────────────────────────────────────────────
    "/domains": {
      get: {
        summary: "List domains",
        tags: ["Domains"],
        responses: {
          "200": { description: "All domains", content: { "application/json": { schema: { type: "array", items: Domain } } } },
        },
      },
      post: {
        summary: "Create a domain",
        tags: ["Domains"],
        requestBody: jsonBody({ allOf: [domainBody], required: ["domain", "allocationModes"] }),
        responses: {
          "201": { description: "Created", content: { "application/json": { schema: Domain } } },
          ...errorResponse("400", "Missing/invalid domain or allocationModes"),
        },
      },
    },
    "/domains/{id}": {
      patch: {
        summary: "Update a domain",
        tags: ["Domains"],
        parameters: [idParam],
        requestBody: jsonBody(domainBody),
        responses: {
          "200": { description: "Updated domain", content: { "application/json": { schema: Domain } } },
          ...errorResponse("400", "Invalid allocationModes"),
          ...errorResponse("404", "Domain not found"),
        },
      },
      delete: { summary: "Delete a domain", tags: ["Domains"], parameters: [idParam], responses: { ...OK } },
    },

    // ── Addresses ────────────────────────────────────────────
    "/addresses": {
      get: {
        summary: "List addresses",
        tags: ["Addresses"],
        parameters: [
          { name: "domainId", in: "query", required: false, schema: { type: "integer" } },
          { name: "status", in: "query", required: false, schema: { type: "string", enum: ["reserved", "active", "revoked"] } },
          { name: "q", in: "query", required: false, schema: { type: "string" }, description: "Username substring search" },
        ],
        responses: {
          "200": {
            description: "Matching addresses (with live-session flag)",
            content: { "application/json": { schema: { type: "array", items: {
              type: "object",
              properties: {
                id: { type: "integer" },
                username: { type: "string" },
                domain: { type: "string", nullable: true },
                status: { type: "string", enum: ["reserved", "active", "revoked"] },
                sessionId: { type: "string", nullable: true },
                online: { type: "boolean", description: "Whether the bound session is currently connected" },
                disabledRails: { type: "array", items: { type: "string" }, description: "Rail ids the operator disabled for this address" },
                rails: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, enabled: { type: "boolean" }, available: { type: "boolean" }, reason: { type: "string", description: "Present when disabled or unavailable" } } }, description: "Effective per-address rail states" },
                createdAt: { type: "integer" },
              },
            } } } },
          },
        },
      },
      post: {
        summary: "Reserve or mint an address",
        description:
          "`reserve` creates a claimable username and returns a one-time `claimCode` (the " +
          "wallet later claims it). `mint` creates an active address bound to a freshly " +
          "generated wallet secret and returns that `secret` once.",
        tags: ["Addresses"],
        requestBody: jsonBody({
          type: "object",
          properties: {
            domain: { type: "string" },
            username: { type: "string" },
            mode: { type: "string", enum: ["reserve", "mint"], description: "Defaults to reserve" },
          },
          required: ["domain", "username"],
        }),
        responses: {
          "201": {
            description: "Created — `claimCode` (reserve) or `secret` (mint) shown once",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                id: { type: "integer" },
                username: { type: "string" },
                domain: { type: "string" },
                status: { type: "string" },
                claimCode: { type: "string", description: "Present for reserve mode" },
                secret: { type: "string", description: "Present for mint mode" },
              },
            } } },
          },
          ...errorResponse("400", "Missing username or invalid mode"),
          ...errorResponse("404", "Unknown domain"),
          ...errorResponse("409", "Username taken or invalid"),
        },
      },
    },
    "/addresses/{id}": {
      patch: {
        summary: "Activate or revoke an address",
        tags: ["Addresses"],
        parameters: [idParam],
        requestBody: jsonBody({ type: "object", properties: { status: { type: "string", enum: ["active", "revoked"] } }, required: ["status"] }),
        responses: { ...OK, ...errorResponse("400", "status must be active or revoked") },
      },
      delete: { summary: "Delete an address", tags: ["Addresses"], parameters: [idParam], responses: { ...OK } },
    },
    "/reconcile": {
      get: {
        summary: "Post-mortem in bulk: what arrived vs what was recorded, across addresses",
        description:
          "Same check as /addresses/{id}/reconcile, over many addresses in one call — an operator asking " +
          "\"did anything go missing\" wants the sweep rather than N calls to stitch together. Indexer reads are " +
          "chunked, so the sweep costs a handful of round trips rather than one per address. A per-address " +
          "failure (no Arkade identity, undecodable address, unknown id, a failed chunk) is reported in place " +
          "rather than failing the batch. Read-only.",
        parameters: [
          {
            name: "ids",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Comma-separated address ids, at most 200. Omitted, covers every address holding an Arkade identity.",
          },
        ],
        responses: {
          "200": {
            description: "Per-address results, each either a reconcile row or an error, plus the batch total",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    unattributed: { type: "integer", description: "Arrivals across the batch that no settlement record accounts for" },
                    addresses: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          addressId: { type: "integer" },
                          arkadeAddress: { type: "string" },
                          script: { type: "string" },
                          unattributed: { type: "integer" },
                          arrivals: { type: "array", items: { type: "object" } },
                          error: { type: "string", description: "Present instead of a result when this address could not be checked" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Malformed or oversized ids" },
          "501": { description: "No Arkade indexer configured (ARK_SERVER_URL)" },
        },
      },
    },
    "/addresses/{id}/reconcile": {
      get: {
        summary: "Post-mortem: what arrived at this address vs what was recorded",
        description:
          "For when a user says they were paid and nothing here shows it. A destination record stops being " +
          "watched after DESTINATION_WATCH_MS, so a later payment is never attributed: verify answers " +
          "\"not found\" and the address history stays blank. The money is not lost — a static Arkade address " +
          "is the user's own, and a covenant destination is still swept to it, because the sweeper reads the " +
          "contract manager rather than the settlement store. Only the record lapses. Read-only: re-attributing " +
          "a lapsed payment at an address shared by every payment to it would be guesswork.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          "200": {
            description: "Arrivals at the address, each flagged with whether a settlement record accounts for it",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    addressId: { type: "integer" },
                    arkadeAddress: { type: "string" },
                    script: { type: "string", description: "hex pkScript the indexer was queried for" },
                    unattributed: { type: "integer", description: "Arrivals no settlement record accounts for" },
                    arrivals: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          txid: { type: "string" },
                          vout: { type: "integer" },
                          value: { type: "integer", description: "sats" },
                          createdAt: { type: "string" },
                          attributed: { type: "boolean" },
                          paymentHash: { type: "string", description: "The record that claims it, when attributed" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Address has no registered Arkade identity, or it is undecodable" },
          "404": { description: "Address not found" },
          "501": { description: "No Arkade indexer configured (ARK_SERVER_URL)" },
          "502": { description: "Indexer lookup failed" },
        },
      },
    },
    "/addresses/{id}/rails": {
      patch: {
        summary: "Replace the per-address rail policy",
        description: "Disable (or re-enable) receive rails for one LN address. Unknown rail ids are rejected; the response carries the stored policy plus the effective states.",
        tags: ["Addresses"],
        parameters: [idParam],
        requestBody: jsonBody({ type: "object", properties: { disabledRails: { type: "array", items: { type: "string", enum: ["interactive-lightning", "offline-swap", "arkade", "covenant"] } } }, required: ["disabledRails"] }),
        responses: { "200": { description: "Stored policy and effective states" }, ...errorResponse("400", "Unknown rail id"), ...errorResponse("404", "Address not found") },
      },
    },

    // ── API keys ─────────────────────────────────────────────
    "/api-keys": {
      get: {
        summary: "List API keys",
        description: "The raw key is never returned here — only on creation.",
        tags: ["API Keys"],
        responses: {
          "200": { description: "API keys", content: { "application/json": { schema: { type: "array", items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              label: { type: "string", nullable: true },
              status: { type: "string", enum: ["active", "revoked"] },
              domainId: { type: "integer", nullable: true, description: "Scope; null = all domains" },
              createdAt: { type: "integer" },
              lastUsedAt: { type: "integer", nullable: true },
            },
          } } } } },
        },
      },
      post: {
        summary: "Create an API key",
        description: "Returns the raw `key` exactly once — store it now.",
        tags: ["API Keys"],
        requestBody: jsonBody({
          type: "object",
          properties: {
            label: { type: "string" },
            domainId: { type: "integer", nullable: true, description: "Scope to a domain; omit/null for all" },
          },
        }, false),
        responses: {
          "201": { description: "Created (raw key shown once)", content: { "application/json": { schema: {
            type: "object",
            properties: {
              id: { type: "integer" },
              label: { type: "string", nullable: true },
              status: { type: "string" },
              domainId: { type: "integer", nullable: true },
              key: { type: "string", description: "Raw API key — shown only here" },
              createdAt: { type: "integer" },
              lastUsedAt: { type: "integer", nullable: true },
            },
          } } } },
        },
      },
    },
    "/api-keys/{id}": {
      delete: { summary: "Revoke an API key", tags: ["API Keys"], parameters: [idParam], responses: { ...OK } },
    },

    // ── Blacklist ────────────────────────────────────────────
    "/blacklist": {
      get: {
        summary: "List blacklist entries",
        description: "Without `domainId`, returns all entries (global + per-domain).",
        tags: ["Blacklist"],
        parameters: [{ name: "domainId", in: "query", required: false, schema: { type: "integer" }, description: "Filter to a domain" }],
        responses: {
          "200": { description: "Blacklist entries", content: { "application/json": { schema: { type: "array", items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              username: { type: "string" },
              domainId: { type: "integer", nullable: true, description: "null = global" },
              reason: { type: "string", nullable: true },
            },
          } } } } },
        },
      },
      post: {
        summary: "Add a blacklist entry",
        tags: ["Blacklist"],
        requestBody: jsonBody({
          type: "object",
          properties: {
            username: { type: "string" },
            domainId: { type: "integer", nullable: true, description: "Omit/null for a global block" },
            reason: { type: "string" },
          },
          required: ["username"],
        }),
        responses: {
          "201": { description: "Created", content: { "application/json": { schema: { type: "object" } } } },
          ...errorResponse("400", "username required"),
        },
      },
    },
    "/blacklist/{id}": {
      delete: { summary: "Remove a blacklist entry", tags: ["Blacklist"], parameters: [idParam], responses: { ...OK } },
    },

    // ── Settlements ──────────────────────────────────────────
    "/settlements": {
      get: {
        summary: "List settlement records",
        description:
          "Read-only audit view over LUD-21 settlement records (relay invoices, offline corridor swaps, " +
          "destination-rail payments). Newest first, filters applied before the limit (a filtered page is " +
          "never truncated by it). The preimage is never exposed (`hasPreimage` flag only) " +
          "and `pr` is omitted as bulk — fetch the public `/lnurl/verify/:paymentHash` for those.",
        tags: ["Settlements"],
        parameters: [
          { name: "settled", in: "query", required: false, schema: { type: "string", enum: ["true", "false"] }, description: "Filter by settlement state" },
          { name: "option", in: "query", required: false, schema: { type: "string" }, description: "Filter by payment option (e.g. lightning, arkade)" },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 200, maximum: 1000 }, description: "Max records (newest first)" },
        ],
        responses: {
          "200": { description: "Settlement records", content: { "application/json": { schema: { type: "array", items: {
            type: "object",
            properties: {
              paymentHash: { type: "string", description: "Verify key (opaque id for destination rails)" },
              sessionId: { type: "string" },
              settled: { type: "boolean" },
              swapId: { type: "string", nullable: true, description: "RFQ id for offline corridor swaps" },
              paymentOption: { type: "string" },
              paymentDestination: { type: "string", nullable: true },
              paymentReference: { type: "string", nullable: true, description: "Observed Arkade txid, once settled by observation" },
              payoutReference: { type: "string", nullable: true, description: "Arkade txid that credited the recipient's own address; differs from paymentReference on the covenant and swap rails" },
              amountMsat: { type: "integer", nullable: true },
              hasPreimage: { type: "boolean", description: "Whether the record holds its preimage (never exposed here)" },
              createdAt: { type: "integer" },
              settledAt: { type: "integer", nullable: true },
            },
          } } } } },
          ...errorResponse("503", "No settlement store configured"),
        },
      },
    },

    // ── Sessions ─────────────────────────────────────────────
    "/sessions": {
      get: {
        summary: "List live wallet sessions",
        description:
          "A live read of the in-memory SSE session map, joined to the addresses table. " +
          "The session token is never exposed.",
        tags: ["Sessions"],
        responses: {
          "200": { description: "Connected sessions", content: { "application/json": { schema: { type: "array", items: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              connectedAt: { type: "integer", description: "Epoch ms when the SSE stream opened" },
              ip: { type: "string", nullable: true, description: "Client IP (post-trust-proxy)" },
              reusable: { type: "boolean", description: "true = token-derived (reconnectable), false = ephemeral random" },
              invoicesIssued: { type: "integer" },
              lastInvoiceAt: { type: "integer", nullable: true },
              pending: {
                type: "object",
                nullable: true,
                description: "In-flight payer request, if any",
                properties: {
                  amountMsat: { type: "integer" },
                  comment: { type: "string" },
                  since: { type: "integer", description: "Epoch ms the request started waiting" },
                },
              },
              addresses: { type: "array", items: {
                type: "object",
                properties: {
                  username: { type: "string" },
                  domain: { type: "string", nullable: true },
                  status: { type: "string" },
                },
              } },
            },
          } } } } },
        },
      },
    },
    "/sessions/{id}/disconnect": {
      post: {
        summary: "Force-disconnect a session",
        description: "Notifies the wallet, ends its SSE stream, and drops the session.",
        tags: ["Sessions"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Session id" }],
        responses: { ...OK, ...errorResponse("404", "Session not found / not live") },
      },
    },

    // ── Settings ─────────────────────────────────────────────
    "/settings": {
      get: {
        summary: "Get settings",
        description:
          "`editable` are the runtime-soft settings (env default + optional DB override, " +
          "applied live). `readOnly` is the process/secret config that needs a restart; " +
          "the token-encryption key is shown only as a status, never its value.",
        tags: ["Settings"],
        responses: {
          "200": { description: "Settings view", content: { "application/json": { schema: {
            type: "object",
            properties: {
              editable: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  properties: {
                    value: { description: "Effective value", oneOf: [{ type: "string" }, { type: "number" }] },
                    default: { description: "Env default", oneOf: [{ type: "string" }, { type: "number" }] },
                    overridden: { type: "boolean" },
                  },
                },
              },
              readOnly: { type: "object", additionalProperties: true },
            },
          } } } },
        },
      },
      patch: {
        summary: "Override editable settings",
        description: "Body is a map of setting key → new value. Applies live (no restart).",
        tags: ["Settings"],
        requestBody: jsonBody({
          type: "object",
          properties: {
            minSendable: { type: "integer" },
            maxSendable: { type: "integer" },
            invoiceTimeoutMs: { type: "integer" },
            baseUrl: { type: "string" },
            registrationRateLimitPerMin: { type: "integer" },
          },
        }),
        responses: {
          "200": { description: "Updated editable view", content: { "application/json": { schema: { type: "object" } } } },
          ...errorResponse("400", "Unknown setting or invalid value"),
        },
      },
    },
    "/settings/{key}": {
      delete: {
        summary: "Reset a setting to its env default",
        tags: ["Settings"],
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" }, description: "Setting key" }],
        responses: {
          "200": { description: "Updated editable view", content: { "application/json": { schema: { type: "object" } } } },
          ...errorResponse("400", "Unknown setting"),
        },
      },
    },
  },
};
