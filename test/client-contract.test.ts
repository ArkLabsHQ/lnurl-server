import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { bech32 } from "@scure/base";
import { createHash } from "node:crypto";
import { createServer } from "../src/server.js";
import type { LnurlServiceConfig } from "../src/types.js";
import {
  createLnurlClient,
  deriveSessionId,
  deriveSessionToken,
  LnurlError,
  LnurlTimeoutError,
} from "../packages/client/src/index.js";
import type { LnurlSession } from "../packages/client/src/index.js";

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1_000, maxSendable: 100_000_000, invoiceTimeoutMs: 3_000 };

function buildInvoice(paymentHashHex: string): string {
  const words: number[] = [];
  for (let i = 0; i < 7; i++) words.push(0);
  const desc = bech32.toWords(new TextEncoder().encode("hello"));
  words.push(13, desc.length >> 5, desc.length & 31, ...desc);
  const hw = bech32.toWords(Uint8Array.from(Buffer.from(paymentHashHex, "hex")));
  words.push(1, 52 >> 5, 52 & 31, ...hw);
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32.encode("lnbc", words, 2000);
}

function startServer() {
  const server = http.createServer();
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${port}`;
      server.on("request", createServer({ ...CONFIG, baseUrl }));
      resolve({ baseUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

const PREIMAGE = "22".repeat(32);
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const noop = () => undefined;

describe("client contract against the real server", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  let sessions: LnurlSession[];
  beforeEach(async () => { ctx = await startServer(); sessions = []; });
  afterEach(async () => { for (const s of sessions) s.close(); await ctx.close(); });

  it("openSession lnurl resolves to a session-surface payRequest", async () => {
    const client = createLnurlClient({ baseUrl: ctx.baseUrl });
    const session = await client.openSession({}, { onInvoiceRequest: noop });
    sessions.push(session);
    const payRequest = await client.resolve(session.lnurl);
    expect(payRequest.tag).toBe("payRequest");
    expect(payRequest.source.surface).toBe("session");
  });

  it("payer requestInvoice receives the exact pr the receiver answered, with a verify URL", async () => {
    const pr = buildInvoice(HASH);
    const receiver = createLnurlClient({ baseUrl: ctx.baseUrl });
    const session = await receiver.openSession({}, {
      onInvoiceRequest: (_req, respond) => { void respond.answerInvoice(pr); },
    });
    sessions.push(session);
    const payer = createLnurlClient({ baseUrl: ctx.baseUrl });
    const payRequest = await payer.resolve(session.lnurl);
    const invoice = await payer.requestInvoice(payRequest, { amountSat: 50 });
    expect(invoice.kind).toBe("bolt11");
    if (invoice.kind !== "bolt11") throw new Error("expected a bolt11 invoice");
    expect(invoice.pr).toBe(pr);
    expect(invoice.verify).toBe(`${ctx.baseUrl}/lnurl/verify/${HASH}`);
  });

  it("pollVerify is unsettled until reportSettled flips it with the preimage", async () => {
    const pr = buildInvoice(HASH);
    const receiver = createLnurlClient({ baseUrl: ctx.baseUrl });
    const session = await receiver.openSession({}, {
      onInvoiceRequest: (_req, respond) => { void respond.answerInvoice(pr); },
    });
    sessions.push(session);
    const payer = createLnurlClient({ baseUrl: ctx.baseUrl });
    const payRequest = await payer.resolve(session.lnurl);
    const invoice = await payer.requestInvoice(payRequest, { amountSat: 50 });
    if (invoice.kind !== "bolt11" || !invoice.verify) throw new Error("expected a bolt11 invoice with a verify URL");
    const pending = await payer.pollVerify(invoice.verify, { timeoutMs: 500, intervalMs: 100 }).then(() => null, (e) => e);
    expect(pending).toBeInstanceOf(LnurlTimeoutError);
    expect((pending as LnurlTimeoutError).lastSnapshot).toMatchObject({ settled: false });
    await session.reportSettled(PREIMAGE);
    const settled = await payer.pollVerify(invoice.verify, { timeoutMs: 5000, intervalMs: 100 });
    expect(settled.settled).toBe(true);
    if (settled.kind !== "bolt11") throw new Error("expected a bolt11 verify status");
    expect(settled.preimage).toBe(PREIMAGE);
  });

  it("rejects an out-of-range amount with the server wording", async () => {
    const client = createLnurlClient({ baseUrl: ctx.baseUrl });
    const session = await client.openSession({}, { onInvoiceRequest: noop });
    sessions.push(session);
    const payRequest = await client.resolve(session.lnurl);
    const err = await client.requestInvoice(payRequest, { amountSat: 200_000 }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(LnurlError);
    expect((err as LnurlError).reason).toMatch(/Amount must be between .* millisats/);
  });

  // The test above never reaches the server — the client range-checks locally first.
  // Widening the payRequest past the server's own bounds is what actually exercises
  // the server's rejection, which is the parity this suite exists to check.
  it("the server's own out-of-range wording matches the client's", async () => {
    const client = createLnurlClient({ baseUrl: ctx.baseUrl });
    const session = await client.openSession({}, { onInvoiceRequest: noop });
    sessions.push(session);
    const payRequest = await client.resolve(session.lnurl);
    const wide = { ...payRequest, maxSendable: 10_000_000_000 };
    const err = await client.requestInvoice(wide, { amountSat: 200_000 }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(LnurlError);
    expect((err as LnurlError).reason).toBe(
      `Amount must be between ${payRequest.minSendable} and ${payRequest.maxSendable} millisats`,
    );
  });

  it("a token-derived session id agrees with the server derivation", async () => {
    const token = deriveSessionToken("ab".repeat(32));
    const client = createLnurlClient({ baseUrl: ctx.baseUrl });
    const session = await client.openSession({ token }, { onInvoiceRequest: noop });
    sessions.push(session);
    expect(session.sessionId).toBe(deriveSessionId(token));
  });
});