export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "LNURL Server",
    description:
      "SSE-based LNURL service for amountless Lightning receives. " +
      "Wallets open an SSE session to get an LNURL, and payers use " +
      "standard LNURL-pay (LUD-06) to request invoices. The wallet " +
      "creates reverse swaps on-the-fly and returns bolt11 invoices.",
    version: "0.1.0",
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
