/**
 * E2E: the arkade destination rail with per-payment covenant addresses.
 *
 * The assertion that matters is the negative one: quote TWICE for the SAME
 * amount, pay only the second, and the first must stay unsettled. Against the
 * static address the watcher had only the amount and an arrival window, so it
 * could not produce that result. Then the sweeper moves the payment on to the
 * registered address, which is all the receiving wallet ever sees.
 *
 * Needs offline-receive.e2e.test.ts's stack plus the emulator, which co-signs
 * the sweep. Run: `pnpm test:e2e`.
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
import { createCovenantDestinationProvider } from "../../src/covenant-destination.js";
import { loadConfig } from "../../src/config.js";
import { createCovenantSweeper, startCovenantSweeper } from "../../src/covenant-sweeper.js";
import { startArkadeWatcher } from "../../src/arkade-watcher.js";
import { ensureStack, pollUntil, mine, faucet, nodeSqliteStorage, ARKD_URL, COVCLAIMD_URL } from "./support/regtest.js";

const AMOUNT_SATS = 3000;
const EMULATOR_URL = process.env.E2E_EMULATOR_URL ?? "http://localhost:7073";
const SETUP_TIMEOUT_MS = 30 * 60_000;
const RAIL_TIMEOUT_MS = 5 * 60_000;

function req(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method: "GET", headers: { Host: "localhost" } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} }));
    });
    r.on("error", reject);
    r.end();
  });
}

function post(url: string, body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Host: "localhost" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const r = http.request(url, { method: "POST", headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} }));
    });
    r.on("error", reject);
    r.write(JSON.stringify(body));
    r.end();
  });
}

/** A throwaway wallet with spendable VTXOs — the payer this rail is missing otherwise. */
async function fundedWallet(log: (s: string) => void): Promise<Wallet> {
  const identity = MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist), { isMainnet: false });
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: ARKD_URL,
    storage: await nodeSqliteStorage(":memory:"),
    settlementConfig: false,
  });
  const boarding = await wallet.getBoardingAddress();
  log(`[setup] fauceting payer boarding ${boarding.slice(0, 18)}…`);
  await faucet(boarding, "0.002");
  await mine(1);
  // arkd needs to see the confirmed deposit before it is a valid settle input.
  for (let attempt = 1; ; attempt++) {
    try {
      await wallet.settle();
      break;
    } catch (err) {
      if (!String(err instanceof Error ? err.message : err).includes("No inputs found") || attempt >= 15) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await mine(1);
  return wallet;
}

describe("e2e: arkade rail, per-payment covenant destinations", () => {
  let db: Db;
  let server: http.Server;
  let baseUrl: string;
  let payer: Wallet;
  let stopWatcher: () => void;
  let stopSweeper: () => void;
  let receiver: { arkadeAddress: string; claimPublicKey: string };
  const token = randomBytes(32).toString("hex");

  beforeAll(async () => {
    await ensureStack();
    payer = await fundedWallet(console.log);

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

    db = openDb(":memory:");
    runMigrations(db);
    bootstrap(db, { bootstrapDomain: "localhost" });
    const repos = createRepositories(db);
    const settlements = new DbSettlementStore(db, 3_600_000);
    // The shipped default, not a chosen value: a delay BIP68 cannot encode makes
    // derivation throw and every payment fall back to the static address.
    const recoveryDelaySeconds = loadConfig({
      NODE_ENV: "test",
      COVCLAIMD_URL,
      ARK_SERVER_URL: ARKD_URL,
      OFFLINE_COVENANT_DESTINATIONS: "true",
      OFFLINE_EMULATOR_URL: EMULATOR_URL,
    }).offlineReceive.covenantRecoveryDelaySeconds;
    const covenantDestinations = createCovenantDestinationProvider({
      arkServerUrl: ARKD_URL,
      covclaimdUrl: COVCLAIMD_URL,
      recoveryDelaySeconds,
    });
    const defaults = { baseUrl: "", minSendable: 1000, maxSendable: 100_000_000_000, invoiceTimeoutMs: 30_000, registrationRateLimitPerMin: 1000 };
    const app = createServer(
      { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000_000, invoiceTimeoutMs: 30_000, trustProxy: false },
      {
        repos,
        addressService: new AddressService(repos, randomBytes(32)),
        settings: staticSettings(defaults),
        settlements,
        covenantDestinations,
      },
    );
    await new Promise<void>((resolve) => {
      server = http.createServer(app).listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    defaults.baseUrl = baseUrl;
    stopWatcher = startArkadeWatcher(settlements, ARKD_URL, 2000);
    stopSweeper = startCovenantSweeper(
      createCovenantSweeper({ store: settlements, arkServerUrl: ARKD_URL, emulatorUrl: EMULATOR_URL }),
      3000,
    );

    expect((await post(`${baseUrl}/lnurl/address`, { token, username: "alice" })).status).toBe(201);
    expect((await post(`${baseUrl}/lnurl/address/alice/arkade`, receiver, token)).status).toBe(200);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    stopWatcher?.();
    stopSweeper?.();
    await payer?.dispose();
    await new Promise<void>((r) => server?.close(() => r()));
    db?.close();
  });

  it(
    "tells two same-amount payments apart by script, then sweeps to the registered address",
    async () => {
      const quote = async () => {
        const cb = await req(`${baseUrl}/.well-known/lnurlp/alice/callback?amount=${AMOUNT_SATS * 1000}&paymentOption=arkade`);
        expect(cb.body.status).not.toBe("ERROR");
        expect(cb.body.paymentOption).toBe("arkade");
        return { destination: String(cb.body.paymentDestination), verifyUrl: String(cb.body.verify) };
      };

      const first = await quote();
      const second = await quote();

      // Identical amount, identical receiver: only the script distinguishes them.
      expect(second.destination).not.toBe(first.destination);
      expect(first.destination).not.toBe(receiver.arkadeAddress);

      const txid = await payer.sendBitcoin({ address: second.destination, amount: AMOUNT_SATS });
      expect(txid).toMatch(/^[0-9a-f]{64}$/);

      await pollUntil(
        "second record settled",
        async () => (await req(second.verifyUrl)).body.settled === true,
        RAIL_TIMEOUT_MS,
        2000,
      );

      const settled = await req(second.verifyUrl);
      expect(settled.body.paymentReference).toBe(txid);
      expect(settled.body.paymentDestination).toBe(second.destination);

      // THE assertion the rail exists for: the unpaid record of the same amount
      // is untouched. Amount-and-window correlation could not tell these apart.
      expect((await req(first.verifyUrl)).body.settled).toBe(false);

      // And the sweep hands it to the wallet as an ordinary arrival.
      const indexer = new RestIndexerProvider(ARKD_URL);
      const staticScript = hex.encode(ArkAddress.decode(receiver.arkadeAddress).pkScript);
      await pollUntil(
        "sweep to the registered address",
        async () => {
          const { vtxos } = await indexer.getVtxos({ scripts: [staticScript], spendableOnly: true });
          return vtxos.some((v) => v.value === AMOUNT_SATS);
        },
        RAIL_TIMEOUT_MS,
        3000,
      );
    },
    RAIL_TIMEOUT_MS * 2,
  );
});
