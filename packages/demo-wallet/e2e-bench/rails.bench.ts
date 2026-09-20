// Wallet-to-wallet latency, per rail, against the local stack.
//
// Its own suite because it runs with PRODUCTION intervals: the correctness
// harness sets OFFLINE_POLL_INTERVAL_MS=2000, which flatters every polled rail
// by 7x and hides exactly what this exists to find. Phases are measured from the
// payer's transaction being accepted, so Arkade's own time is told apart from
// whatever this server adds on top.
import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { bech32, hex } from "@scure/base";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ArkAddress, MnemonicIdentity, RestIndexerProvider, Wallet } from "@arkade-os/sdk";
import { createLnurlClient, type PayRequest } from "@arkade-os/lnurl-client";
import { ESPLORA_URL, faucet, mine, nodeSqliteStorage } from "../../../test/e2e/support/regtest.js";
import {
  CARDS_FILE,
  STATE_DIR,
  readLocalStack,
  startLnurlServer,
  type LnurlServerHandle,
  type LocalStack,
} from "../e2e-local/local-stack.js";

const STATIC_PORT = 4301;
const STATIC_ADMIN_PORT = 4302;
const COVENANT_PORT = 4303;
const COVENANT_ADMIN_PORT = 4304;

/** What ships when an operator sets nothing. @see config.ts pollIntervalMs */
const PRODUCTION_POLL_MS = "15000";

const SATS = 2500;
const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const DEADLINE_MS = 4 * 60_000;

const payer = createLnurlClient();
const name = (prefix: string) => `${prefix}${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

let stack: LocalStack;
let payerWallet: Wallet;
let staticServer: LnurlServerHandle;
let covenantServer: LnurlServerHandle;
const opened: Wallet[] = [];
const results: Sample[] = [];

interface Sample {
  rail: string;
  quoteMs: number;
  /** Payment accepted -> this server calls it settled. Zero where none watches. */
  observeMs: number;
  /** Payment accepted -> the recipient holds a spendable VTXO. */
  spendableMs: number;
}

async function newWallet(): Promise<{ wallet: Wallet; identity: MnemonicIdentity }> {
  const identity = MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist), { isMainnet: false });
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: stack.arkServer,
    esploraUrl: ESPLORA_URL,
    storage: await nodeSqliteStorage(":memory:"),
    settlementConfig: false,
  });
  opened.push(wallet);
  return { wallet, identity };
}

async function newUser() {
  const { wallet, identity } = await newWallet();
  return {
    wallet,
    arkadeAddress: await wallet.getAddress(),
    claimPublicKey: hex.encode(await identity.compressedPublicKey()),
  };
}

async function register(base: string, username: string, user: Awaited<ReturnType<typeof newUser>>) {
  const token = randomBytes(32).toString("hex");
  const owner = createLnurlClient({ baseUrl: base });
  await owner.registerAddress({ token, username });
  await owner.registerArkadeIdentity({
    token, username, arkadeAddress: user.arkadeAddress, claimPublicKey: user.claimPublicKey,
  });
  return { token, owner };
}

async function payRequestFor(base: string, username: string): Promise<PayRequest> {
  const url = `${base}/.well-known/lnurlp/${username}`;
  const lnurl = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 1023);
  const request = await payer.resolve(lnurl);
  const { hostname, host } = new URL(base);
  return { ...request, callback: request.callback.replace(hostname, host) };
}

const indexer = () => new RestIndexerProvider(stack.arkServer);

async function spendableAt(arkadeAddress: string): Promise<number> {
  const script = hex.encode(ArkAddress.decode(arkadeAddress).pkScript);
  const { vtxos } = await indexer().getVtxos({ scripts: [script], spendableOnly: true });
  return vtxos.reduce((sum, v) => sum + v.value, 0);
}

/** Poll until `read` is truthy, returning ms elapsed since `from`. Tight interval:
 *  the sampling grain must not be the thing being measured. */
async function elapsedUntil(from: number, label: string, read: () => Promise<boolean>): Promise<number> {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    if (await read()) return Date.now() - from;
    if (Date.now() > deadline) throw new Error(`${label}: still false after ${DEADLINE_MS}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  stack = readLocalStack();
  const { wallet } = await newWallet();
  payerWallet = wallet;
  await faucet(await payerWallet.getBoardingAddress(), "0.01");
  await mine(1);
  for (let attempt = 1; ; attempt++) {
    try { await payerWallet.settle(); break; } catch (err) {
      if (attempt >= 15) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await mine(1);

  staticServer = await startLnurlServer({
    port: STATIC_PORT, adminPort: STATIC_ADMIN_PORT,
    dbPath: join(STATE_DIR, "bench-static.sqlite"), cardsFile: CARDS_FILE, logName: "bench-static.log",
    env: { OFFLINE_POLL_INTERVAL_MS: PRODUCTION_POLL_MS },
  });
  covenantServer = await startLnurlServer({
    port: COVENANT_PORT, adminPort: COVENANT_ADMIN_PORT,
    dbPath: join(STATE_DIR, "bench-covenant.sqlite"), cardsFile: CARDS_FILE, logName: "bench-covenant.log",
    env: { OFFLINE_POLL_INTERVAL_MS: PRODUCTION_POLL_MS, OFFLINE_COVENANT_DESTINATIONS: "true" },
  });
});

test.afterAll(async () => {
  await staticServer?.stop();
  await covenantServer?.stop();
  for (const wallet of opened) await wallet.dispose().catch(() => undefined);
  report();
});

function report(): void {
  const rails = [...new Set(results.map((r) => r.rail))];
  const stat = (xs: number[]) => ({
    min: Math.min(...xs), med: xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!, max: Math.max(...xs),
  });
  console.log(`\nLATENCY (ms, n=${RUNS} per rail, OFFLINE_POLL_INTERVAL_MS=${PRODUCTION_POLL_MS})`);
  console.log("rail".padEnd(26) + "quote".padEnd(10) + "observe(med)".padEnd(16) + "spendable(med)".padEnd(16) + "spendable(max)");
  for (const rail of rails) {
    const rows = results.filter((r) => r.rail === rail);
    const q = stat(rows.map((r) => r.quoteMs));
    const o = stat(rows.map((r) => r.observeMs));
    const s = stat(rows.map((r) => r.spendableMs));
    console.log(
      rail.padEnd(26) + String(q.med).padEnd(10) + String(o.med).padEnd(16) + String(s.med).padEnd(16) + String(s.max),
    );
  }
  console.log("");
}

test("ark: a bare Arkade transfer, the floor every LNURL rail is measured against", async () => {
  test.setTimeout(10 * 60_000);
  for (let i = 0; i < RUNS; i++) {
    const user = await newUser();
    const before = await spendableAt(user.arkadeAddress);
    const sent = Date.now();
    await payerWallet.sendBitcoin({ address: user.arkadeAddress, amount: SATS });
    const spendableMs = await elapsedUntil(sent, "ark spendable", async () => (await spendableAt(user.arkadeAddress)) > before);
    results.push({ rail: "ark (no server)", quoteMs: 0, observeMs: 0, spendableMs });
  }
  expect(results.filter((r) => r.rail === "ark (no server)")).toHaveLength(RUNS);
});

test("lnurl-arkade, static destination: settlement the server can only observe", async () => {
  test.setTimeout(10 * 60_000);
  for (let i = 0; i < RUNS; i++) {
    const user = await newUser();
    const username = name("bst");
    const { token, owner } = await register(staticServer.base, username, user);

    const quoteStart = Date.now();
    const request = await payRequestFor(staticServer.base, username);
    const result = await payer.requestInvoice(request, { amountSat: SATS, paymentOption: "arkade" });
    const quoteMs = Date.now() - quoteStart;
    if (result.kind !== "destination") throw new Error(`expected a destination, got ${result.kind}`);

    const sent = Date.now();
    await payerWallet.sendBitcoin({ address: result.paymentDestination!, amount: SATS });
    const spendableMs = await elapsedUntil(sent, "static spendable", async () => (await spendableAt(user.arkadeAddress)) > 0);
    const observeMs = await elapsedUntil(sent, "static observed", async () => {
      const page = await owner.listPayments(token, username);
      return page.payments.some((p) => p.settled);
    });
    results.push({ rail: "lnurl-arkade static", quoteMs, observeMs, spendableMs });
  }
  expect(results.filter((r) => r.rail === "lnurl-arkade static")).toHaveLength(RUNS);
});

test("lnurl-arkade, covenant destination: an address per payment, then a sweep", async () => {
  test.setTimeout(10 * 60_000);
  for (let i = 0; i < RUNS; i++) {
    const user = await newUser();
    const username = name("bcv");
    const { token, owner } = await register(covenantServer.base, username, user);

    const quoteStart = Date.now();
    const request = await payRequestFor(covenantServer.base, username);
    const result = await payer.requestInvoice(request, { amountSat: SATS, paymentOption: "arkade" });
    const quoteMs = Date.now() - quoteStart;
    if (result.kind !== "destination") throw new Error(`expected a destination, got ${result.kind}`);

    const sent = Date.now();
    await payerWallet.sendBitcoin({ address: result.paymentDestination!, amount: SATS });
    const observeMs = await elapsedUntil(sent, "covenant observed", async () => {
      const page = await owner.listPayments(token, username);
      return page.payments.some((p) => p.settled);
    });
    // The sweep, not the payment, is what the recipient can spend.
    const spendableMs = await elapsedUntil(sent, "covenant swept", async () => (await spendableAt(user.arkadeAddress)) > 0);
    results.push({ rail: "lnurl-arkade covenant", quoteMs, observeMs, spendableMs });
  }
  expect(results.filter((r) => r.rail === "lnurl-arkade covenant")).toHaveLength(RUNS);
});
