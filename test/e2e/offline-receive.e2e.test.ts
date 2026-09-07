/**
 * E2E: offline Lightning receive through the intents corridor, for real.
 *
 * The full funded path, no fakes anywhere: this repo's lnurl-server (in-process,
 * wired exactly like cli.ts) quotes a `lightning:BTC->arkade:BTC` swap with the
 * regtest intent-solver over its HTTP API; the stack's counterparty LND pays the
 * hold invoice for real; the solver funds a VHTLC pinned to the user's registered
 * Arkade address; covclaimd decrypts OUR sealed claim packet (the vendored
 * sealClaimPacket) and claims; the solver settles the HTLC; the server's settlement
 * poller flips LUD-21 verify via the solver's RFQ status.
 *
 * Assertions that no fake can make: the payer's own node reports SUCCEEDED with the
 * preimage; `verify` reveals that same preimage; and the VTXO landed on the user's
 * Arkade address — the covenant paid only the user.
 *
 * Prerequisites: docker + `git submodule update --init`. The suite brings the stack
 * up itself (arkade-regtest at ./regtest, intent-solver image built from upstream
 * master on first run) and reuses a healthy stack on later runs.
 *
 * Run: `pnpm test:e2e` (never in the unit suite — vitest.config.ts excludes test/e2e).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { hex } from "@scure/base";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { MnemonicIdentity, Wallet, RestIndexerProvider, ArkAddress } from "@arkade-os/sdk";
import { createServer } from "../../src/server.js";
import { openDb, type Db } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { bootstrap } from "../../src/bootstrap.js";
import { createRepositories } from "../../src/db/repositories/index.js";
import { AddressService } from "../../src/address-service.js";
import { DbSettlementStore } from "../../src/settlement-store.js";
import { staticSettings } from "../../src/settings.js";
import { createIntentSwapCreator, type OfflineSwapCreator } from "../../src/intent-swap.js";
import { startOfflineSettlementPoller } from "../../src/offline-poller.js";
import {
  ensureStack,
  fundSolverFloat,
  payFromCounterparty,
  counterpartyPayment,
  pollUntil,
  mine,
  nodeSqliteStorage,
  ARKD_URL,
  COVCLAIMD_URL,
  SOLVER_URL,
} from "./support/regtest.js";

const AMOUNT_SATS = 5000;
const SETUP_TIMEOUT_MS = 30 * 60_000; // first boot pulls ~20 images + builds the solver
const SWAP_TIMEOUT_MS = 12 * 60_000;

function req(url: string, method: string, body?: unknown, token?: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Host: "localhost" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const r = http.request(url, { method, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

describe("e2e: offline receive via the intents corridor", () => {
  let db: Db;
  let server: http.Server;
  let baseUrl: string;
  let stopPoller: () => void;
  let settlements: DbSettlementStore;
  let receiver: { arkadeAddress: string; claimPublicKey: string };
  const token = randomBytes(32).toString("hex");
  let payer: { stop: () => void } | undefined;

  beforeAll(async () => {
    console.log("[setup] ensuring regtest stack…");
    await ensureStack();
    console.log("[setup] funding solver float…");
    await fundSolverFloat();
    console.log("[setup] creating receiver identity…");

    // The receiving user's identity — derives an address and goes offline for good.
    const identity = MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist), { isMainnet: false });
    const wallet = await Wallet.create({
      identity,
      arkServerUrl: ARKD_URL,
      storage: await nodeSqliteStorage(":memory:"),
      settlementConfig: false,
    });
    receiver = {
      arkadeAddress: await wallet.getAddress(),
      claimPublicKey: hex.encode(await identity.compressedPublicKey()),
    };
    await wallet.dispose();

    // lnurl-server, in-process, DB mode — the same wiring as cli.ts.
    console.log("[setup] starting lnurl-server…");
    db = openDb(":memory:");
    runMigrations(db);
    bootstrap(db, { bootstrapDomain: "localhost" });
    const repos = createRepositories(db);
    const addressService = new AddressService(repos, randomBytes(32));
    settlements = new DbSettlementStore(db, 3_600_000);
    const creator: OfflineSwapCreator = await createIntentSwapCreator({
      solverUrl: SOLVER_URL,
      covclaimdUrl: COVCLAIMD_URL,
      arkServerUrl: ARKD_URL,
    });
    const defaults = { baseUrl: "", minSendable: 1000, maxSendable: 100_000_000_000, invoiceTimeoutMs: 30_000, registrationRateLimitPerMin: 1000 };
    const app = createServer(
      { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000_000, invoiceTimeoutMs: 30_000, trustProxy: false },
      { repos, addressService, settings: staticSettings(defaults), settlements, offlineSwapCreator: creator },
    );
    await new Promise<void>((resolve) => {
      server = http.createServer(app).listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    defaults.baseUrl = baseUrl; // staticSettings reads it per request
    stopPoller = startOfflineSettlementPoller(settlements, creator, 1000);

    // Register the LN address + its Arkade receive identity, then go "offline".
    const reg = await req(`${baseUrl}/lnurl/address`, "POST", { token, username: "alice" });
    expect(reg.status).toBe(201);
    const ark = await req(`${baseUrl}/lnurl/address/alice/arkade`, "POST", receiver, token);
    expect(ark.status).toBe(200);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    payer?.stop();
    stopPoller?.();
    await new Promise<void>((r) => server?.close(() => r()));
    db?.close();
  });

  it("pays an offline LN address end to end: corridor swap, covclaimd claim, verify flip", async () => {
    // A payer hits the offline address's callback — the server quotes the corridor.
    const cb = await req(`${baseUrl}/.well-known/lnurlp/alice/callback?amount=${AMOUNT_SATS * 1000}`, "GET");
    expect(cb.body.status).not.toBe("ERROR");
    const pr = String(cb.body.pr);
    expect(pr).toMatch(/^lnbcrt/); // regtest invoice
    const verifyUrl = String(cb.body.verify);
    expect(verifyUrl).toContain("/lnurl/verify/");
    const paymentHash = verifyUrl.split("/").pop()!;

    // The payer pays the solver's hold invoice for real (returns immediately;
    // payinvoice blocks on the held HTLC for the life of the swap).
    payer = payFromCounterparty(pr);

    // The settlement store holds the swap's rfq id — the raw solver status tells
    // us when the lockup is funded; its batch needs one on-chain confirmation
    // before covclaimd's claim can be co-signed, so mine when it lands (and then
    // slowly, so the claim's own batch confirms too). Bounded: the HTLC's CLTV
    // budget (54 blocks) is never approached.
    const swapId = settlements.get(paymentHash)?.swapId;
    if (!swapId) throw new Error(`no settlement record / swap id for ${paymentHash} — the callback should have created one`);
    console.log(`[test] rfq ${swapId} — payment hash ${paymentHash}`);
    let minedFunding = false;
    let blocksMined = 0;
    let lastMine = 0;
    let settled: Record<string, unknown> = {};
    let swapState: string | undefined;
    let swapStateAt = 0;
    await pollUntil(
      "verify settled",
      async () => {
        if (swapId) {
          const raw = (await fetch(`${SOLVER_URL}/v1/rfq/${swapId}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)) as { state?: string } | null;
          if (raw?.state && raw.state !== swapState) {
            swapState = raw.state;
            swapStateAt = Date.now();
          }
          if ((raw?.state === "funded" || raw?.state === "claimed") && !minedFunding) {
            minedFunding = true;
            await mine(2);
            blocksMined += 2;
            lastMine = Date.now();
          }
        }
        if (minedFunding && blocksMined < 20 && Date.now() - lastMine > 30_000) {
          await mine(1);
          blocksMined += 1;
          lastMine = Date.now();
        }
        const v = await req(verifyUrl, "GET");
        if (v.body.settled === true) {
          settled = v.body;
          return true;
        }
        return false;
      },
      SWAP_TIMEOUT_MS - 60_000,
      3000,
      () =>
        `swap ${swapId} stuck at ${swapState ?? "unknown"}` +
        (swapStateAt ? ` for ${Math.round((Date.now() - swapStateAt) / 1000)}s` : "") +
        `, ${blocksMined} blocks mined`,
    );

    // THE assertion the whole corridor exists for: the preimage verify reveals is the
    // one the payer's own node settled with — and it was never disclosed before the claim.
    const preimage = String(settled.preimage);
    expect(preimage).toMatch(/^[0-9a-f]{64}$/);
    const payment = await counterpartyPayment(paymentHash);
    expect(payment?.status).toBe("SUCCEEDED");
    expect(payment?.payment_preimage).toBe(preimage);
    expect(Number(payment?.value_sat)).toBe(AMOUNT_SATS);

    // And the covenant did its one job: the sats landed on the user's Arkade address.
    const script = hex.encode(ArkAddress.decode(receiver.arkadeAddress).pkScript);
    const indexer = new RestIndexerProvider(ARKD_URL);
    const { vtxos } = await indexer.getVtxos({ scripts: [script] });
    const received = vtxos.reduce((sum, v) => sum + v.value, 0);
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThanOrEqual(AMOUNT_SATS);
  }, SWAP_TIMEOUT_MS);
});
