import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { ArkAddress } from "@arkade-os/sdk";
import { createServer } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/services/addresses.js";
import { MemorySettlementStore } from "../src/settlement-store.js";
import { deriveSessionId } from "../src/session-token.js";
import type { OfflineSwapCreator, OfflineSwapParams, OfflineSwapResult } from "../src/services/offline-swaps.js";
import type { AddressRow, DomainRow } from "../src/types/index.js";
import type { LnurlServiceConfig } from "../src/types/index.js";
import { buildInvoice } from "./helpers/bolt11.js";

const KEY = randomBytes(32);
const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
const TOKEN = "cd".repeat(32);
const SID = deriveSessionId(TOKEN);
const RECEIVE = new ArkAddress(new Uint8Array(32), new Uint8Array(32), "tark").encode();
const CLAIM_PUBKEY = "02" + "ab".repeat(32);
const SWAP_HASH = "9a" + "00".repeat(31);

class FakeCreator implements OfflineSwapCreator {
  created: OfflineSwapParams[] = [];
  async create(params: OfflineSwapParams): Promise<OfflineSwapResult> {
    this.created.push(params);
    return {
      swapId: "swap-1", invoice: buildInvoice(SWAP_HASH), preimage: "11".repeat(32), preimageHash: SWAP_HASH, lockupAddress: RECEIVE,
      recovery: { version: 1, solverName: "fake", solverPubkey: "11".repeat(32), relays: ["wss://relay.invalid"], rfqId: "swap-1", lockupAddress: RECEIVE, expectedAmount: params.amountSat, script: {} },
    };
  }
  async isSettled(): Promise<boolean> { return false; }
}

let db: Db; let repos: Repositories; let svc: AddressService; let settlements: MemorySettlementStore;
let domain: DomainRow; let ctx: { baseUrl: string; close: () => Promise<void> } | undefined;

function start(creator?: OfflineSwapCreator) {
  const server = http.createServer();
  return new Promise<NonNullable<typeof ctx>>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${port}`;
      server.on("request", createServer({ ...CONFIG, baseUrl }, { repos, addressService: svc, settlements, offlineSwapCreator: creator }));
      resolve({ baseUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}
function get(path: string, host = "domain.com") {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    http.get(`${ctx!.baseUrl}${path}`, { headers: { Host: host } }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); }).on("error", reject);
  });
}
function postInvoice(pr: string, sid = SID, token = TOKEN) {
  return new Promise<void>((resolve, reject) => {
    const r = http.request(`${ctx!.baseUrl}/lnurl/session/${sid}/invoice`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    }, (res) => { res.on("data", () => {}); res.on("end", () => resolve()); });
    r.on("error", reject); r.write(JSON.stringify({ pr })); r.end();
  });
}
function openSse(token = TOKEN) {
  return new Promise<{ waitFor: (text: string) => Promise<void>; abort: () => void }>((resolve, reject) => {
    const r = http.request(`${ctx!.baseUrl}/lnurl/session`, { method: "POST", headers: { "Content-Type": "application/json" } });
    let buf = "";
    const waiters: { text: string; from: number; done: () => void }[] = [];
    const check = () => { for (const w of [...waiters]) if (buf.indexOf(w.text, w.from) >= 0) { waiters.splice(waiters.indexOf(w), 1); w.done(); } };
    r.on("response", (res) => {
      res.on("data", (c: Buffer) => { buf += c.toString(); check(); });
      const waitFor = (text: string) => new Promise<void>((done) => { waiters.push({ text, from: buf.length, done }); check(); });
      void waitFor("session_created").then(() => resolve({ waitFor, abort: () => { res.destroy(); r.destroy(); } }));
    });
    r.on("error", reject); r.write(JSON.stringify({ token })); r.end();
  });
}
const metadataOf = (meta: Record<string, unknown>) => JSON.parse(String(meta.metadata)) as [string, string][];
const nameless = (): AddressRow => svc.registerNameless({ domain, token: TOKEN }).address;

beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  svc = new AddressService(repos, KEY);
  settlements = new MemorySettlementStore(60_000);
  repos.domains.create({ domain: "domain.com", allocationModes: ["self", "session"] });
  repos.domains.create({ domain: "other.com", allocationModes: ["self", "session"] });
  domain = repos.domains.getByDomain("domain.com")!;
});
afterEach(async () => { await ctx?.close(); ctx = undefined; db.close(); });

describe("/lnurl/:id for a nameless row", () => {
  it("serves the row's payRequest and offline swap, with a session-scoped callback and no identifier", async () => {
    const creator = new FakeCreator();
    const row = nameless();
    repos.addresses.setOfflineReceive(row.id, RECEIVE, CLAIM_PUBKEY);
    ctx = await start(creator);

    const meta = await get(`/lnurl/${SID}`);
    expect(meta.tag).toBe("payRequest");
    expect(meta.callback).toBe(`http://domain.com/lnurl/${SID}/callback`);
    expect(meta.paymentOptions).toContainEqual({ id: "arkade", type: "arkade" });
    expect(metadataOf(meta).map(([k]) => k)).not.toContain("text/identifier");

    const cb = await get(`/lnurl/${SID}/callback?amount=50000`);
    expect(cb.pr).toBe(buildInvoice(SWAP_HASH));
    expect(creator.created[0]).toEqual({ amountSat: 50, receiveAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY });
    expect(settlements.get(SWAP_HASH)?.addressId).toBe(row.id);
  });

  it("says the LNURL, not an address, is offline", async () => {
    nameless();
    ctx = await start();
    expect(await get(`/lnurl/${SID}/callback?amount=50000`)).toEqual({ status: "ERROR", reason: "This LNURL is currently offline" });
  });

  it("refuses the hex handle at .well-known", async () => {
    nameless();
    ctx = await start();
    const unknown = { status: "ERROR", reason: "Unknown LN address" };
    expect(await get(`/.well-known/lnurlp/${SID}`)).toEqual(unknown);
    expect(await get(`/.well-known/lnurlp/${SID}/callback?amount=50000`)).toEqual(unknown);
  });

  it("after upgrade, serves the same named row on both URLs", async () => {
    const row = nameless();
    repos.addresses.setOfflineReceive(row.id, RECEIVE, CLAIM_PUBKEY);
    svc.upgrade({ domain, handle: SID, token: TOKEN, username: "alice" });
    ctx = await start();

    const viaSession = await get(`/lnurl/${SID}`);
    const viaName = await get("/.well-known/lnurlp/alice");
    expect(metadataOf(viaSession)).toContainEqual(["text/identifier", "alice@domain.com"]);
    expect(viaSession.metadata).toBe(viaName.metadata);
    expect(viaSession.paymentOptions).toEqual(viaName.paymentOptions);
    expect(viaSession.callback).toBe(`http://domain.com/lnurl/${SID}/callback`);
    expect(viaName.callback).toBe("http://domain.com/.well-known/lnurlp/alice/callback");
    expect(await get(`/lnurl/${SID}/callback?amount=50000`)).toEqual({ status: "ERROR", reason: "alice@domain.com is currently offline" });
  });

  it("after upgrade, routes the invoice request to the live wallet via both URLs", async () => {
    const row = nameless();
    ctx = await start();
    const sse = await openSse();
    try {
      svc.upgrade({ domain, handle: SID, token: TOKEN, username: "alice" });
      for (const [i, path] of [`/lnurl/${SID}/callback`, "/.well-known/lnurlp/alice/callback"].entries()) {
        const hash = String(i + 1).padStart(64, "0");
        const payer = get(`${path}?amount=50000`);
        await sse.waitFor("invoice_request");
        await postInvoice(buildInvoice(hash));
        expect((await payer).pr).toBe(buildInvoice(hash));
        expect(settlements.get(hash)?.addressId).toBe(row.id);
      }
    } finally { sse.abort(); }
  });
});

describe("/lnurl/:id for a named (non-flagged) row", () => {
  it("keeps today's plain session behavior, not the address one", async () => {
    const namedToken = "ab".repeat(32);
    const namedSid = deriveSessionId(namedToken);
    svc.register({ domain, username: "alice", token: namedToken });
    ctx = await start();
    const sse = await openSse(namedToken);
    try {
      const meta = await get(`/lnurl/${namedSid}`);
      expect(meta.callback).toBe(`${ctx.baseUrl}/lnurl/${namedSid}/callback`);
      expect(metadataOf(meta).map(([k]) => k)).not.toContain("text/identifier");

      const payer = get(`/lnurl/${namedSid}/callback?amount=50000`);
      await sse.waitFor("invoice_request");
      const hash = "77".repeat(32);
      await postInvoice(buildInvoice(hash), namedSid, namedToken);
      expect((await payer).pr).toBe(buildInvoice(hash));
    } finally { sse.abort(); }
  });
});

describe("/lnurl/:id falls back to session behavior", () => {
  it("on a Host whose domain holds no flagged row for the id", async () => {
    nameless();
    ctx = await start();
    const inactive = { status: "ERROR", reason: "This LNURL is no longer active" };
    expect(await get(`/lnurl/${SID}`, "other.com")).toEqual(inactive);
    expect(await get(`/lnurl/${SID}/callback?amount=50000`, "other.com")).toEqual(inactive);
  });

  it("on a disabled domain", async () => {
    nameless();
    repos.domains.update(domain.id, { enabled: false });
    ctx = await start();
    const inactive = { status: "ERROR", reason: "This LNURL is no longer active" };
    expect(await get(`/lnurl/${SID}`)).toEqual(inactive);
    expect(await get(`/lnurl/${SID}/callback?amount=50000`)).toEqual(inactive);
  });

  it("for a revoked row, so a live wallet is never stranded", async () => {
    repos.addresses.updateStatus(nameless().id, "revoked");
    ctx = await start();
    expect(await get(`/lnurl/${SID}`)).toEqual({ status: "ERROR", reason: "This LNURL is no longer active" });
    const sse = await openSse();
    try {
      const meta = await get(`/lnurl/${SID}`);
      expect(meta.callback).toBe(`${ctx.baseUrl}/lnurl/${SID}/callback`);
      expect(metadataOf(meta).map(([k]) => k)).not.toContain("text/identifier");
    } finally { sse.abort(); }
  });
});
