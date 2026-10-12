import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hex } from "@scure/base";
import { Wallet, MnemonicIdentity, RestArkProvider, RestIndexerProvider, RestEmulatorProvider, EsploraProvider,
  ContractManager, contractHandlers, networkFromArkadeInfo, type ArkProvider, type VirtualCoin } from "@arkade-os/sdk";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { DbSettlementStore } from "../../src/settlement-store.js";
import { sqliteContractStores } from "../../src/contract-store.js";
import { covenantDestinationHandler } from "../../src/covenant/contract.js";
import { createCovenantDestinationProvider } from "../../src/covenant/destination.js";
import { createCovenantRenewer } from "../../src/covenant/renewal.js";
import { createCovenantSweeper } from "../../src/workers/covenant-sweeper.js";
import { ensureStack, pollUntil, faucet, mine, nodeSqliteStorage, ARKD_URL, EMULATOR_URL, ESPLORA_URL, REGTEST_DIR } from "./support/regtest.js";

const externalEnv = process.env.E2E_REGTEST_ENV;
const command = (...args: string[]) => execFileSync(process.execPath,
  [join(REGTEST_DIR, "regtest.mjs"), ...args, "--env", resolve(externalEnv!)], { stdio: "pipe", timeout: 60_000 });
const mineBlock = async () => externalEnv ? command("mine", "1") : mine(1);

describe("e2e: compiled covenant renewal and forwarding", () => {
  let payer: Wallet;
  let receiver: Wallet;
  let feePayer: Wallet;
  let contracts: ContractManager;
  const db = openDb(":memory:");
  const ark = new RestArkProvider(ARKD_URL);
  const indexer = new RestIndexerProvider(ARKD_URL);
  const emulator = new RestEmulatorProvider(EMULATOR_URL);

  beforeAll(async () => {
    if (!externalEnv) await ensureStack();
    else expect((await fetch(`${ARKD_URL}/v1/info`)).ok).toBe(true);
    runMigrations(db);
    const makeWallet = async () => Wallet.create({
      identity: MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist), { isMainnet: false }),
      arkProvider: ark, onchainProvider: new EsploraProvider(ESPLORA_URL),
      storage: await nodeSqliteStorage(":memory:"), settlementConfig: false,
    });
    payer = await makeWallet();
    receiver = await makeWallet();
    feePayer = await makeWallet();
    const boarding = await payer.getBoardingAddress();
    if (externalEnv) command("faucet", boarding, "0.002");
    else await faucet(boarding, "0.002");
    await mineBlock();
    await pollUntil("confirmed payer deposit", async () => (await payer.getBoardingUtxos()).some((coin) => coin.status.confirmed), 60_000);
    await payer.settle();
    await mineBlock();
    await payer.send({ address: await feePayer.getAddress(), amount: 10_000 });
    await pollUntil("separate renewal fee funding", async () => (await feePayer.getBalance()).available >= 10_000, 60_000);
    contractHandlers.register(covenantDestinationHandler);
    contracts = await ContractManager.create({ indexerProvider: indexer, ...(await sqliteContractStores(db)) });
  }, 30 * 60_000);

  afterAll(async () => {
    contracts?.dispose();
    await payer?.dispose();
    await receiver?.dispose();
    await feePayer?.dispose();
    db.close();
  });

  it.each(["btc", "asset", "zero-fee-asset"])("renews %s without the recipient key, survives restart, then forwards the full payment", async (kind) => {
    const zeroFee = kind.startsWith("zero-fee");
    const feeUrl = `${process.env.E2E_ARKD_ADMIN_URL ?? "http://localhost:7071"}/v1/admin/intentFees`;
    const originalFees = zeroFee ? await (await fetch(feeUrl)).json() : undefined;
    const setFees = async (fees: unknown) => {
      const response = await fetch(feeUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fees) });
      if (!response.ok) throw new Error(`test intent-fee configuration failed: ${response.status}`);
      await ark.getInfo();
    };
    try {
      if (zeroFee) await setFees({ fees: { offchainInputFee: "0.0", onchainInputFee: "0.0", offchainOutputFee: "0.0", onchainOutputFee: "0.0" } });
      const paymentHash = `renew-e2e-${kind}`;
      const assets = kind.includes("asset") ? [{ assetId: (await payer.assetManager.issue({ amount: 1000n })).assetId, amount: 100n }] : [];
      const destination = await receiver.getAddress();
      const provider = createCovenantDestinationProvider({ arkServerUrl: ARKD_URL, emulatorUrl: EMULATOR_URL,
        recoveryDelaySeconds: 4096, contracts });
      const derived = await provider.derive({ arkadeAddress: destination, claimPublicKey: hex.encode(await receiver.identity.compressedPublicKey()) });
      const [contract] = await contracts.getContracts({ script: derived.script });
      expect(contract!.params.version).toBe("3");
      const store = new DbSettlementStore(db, 3_600_000);
      store.create({ paymentHash, pr: "", sessionId: "s", paymentOption: "arkade",
        paymentDestination: derived.address, amountMsat: 3_000_000, covenantScript: derived.script });
      const fundedTxid = await payer.send({ address: derived.address, amount: 3000, assets });
      let funded: VirtualCoin | undefined;
      await pollUntil("funded v3 covenant", async () => {
        funded = (await indexer.getVtxos({ scripts: [derived.script] })).vtxos.find((v) => v.txid === fundedTxid && !v.isSpent);
        return Boolean(funded);
      }, 60_000);
      expect(funded!.assets ?? []).toEqual(assets);
      store.markObserved(paymentHash, funded!.txid);
      store.setCovenantOutpoint(paymentHash, { txid: funded!.txid, vout: funded!.vout }, null);
      let canceled = false;
      const ambiguousArk = new Proxy(ark, { get(target, key) {
        if (key === "registerIntent") return async (intent: Parameters<ArkProvider["registerIntent"]>[0]) => {
          await target.registerIntent(intent);
          throw new Error("ambiguous renewal registration");
        };
        if (key === "deleteIntent") return async (intent: Parameters<ArkProvider["deleteIntent"]>[0]) => {
          await target.deleteIntent(intent);
          canceled = true;
        };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const interrupted = createCovenantRenewer({ arkProvider: ambiguousArk, indexer, emulator,
        network: networkFromArkadeInfo(await ark.getInfo()), feePayer: zeroFee ? undefined : feePayer });
      await expect(interrupted.renew(contract!, funded!)).rejects.toThrow("ambiguous renewal registration");
      expect(canceled).toBe(true);
      expect(store.get(paymentHash)!.payoutReference).toBeNull();
      const renewer = createCovenantRenewer({ arkProvider: ark, indexer, emulator,
        network: networkFromArkadeInfo(await ark.getInfo()), feePayer: zeroFee ? undefined : feePayer });
      const commitment = await renewer.renew(contract!, funded!);
      expect(commitment).toMatch(/^[0-9a-f]{64}$/);
      await mineBlock();
      let successor: VirtualCoin | undefined;
      await pollUntil("renewal successor", async () => {
        successor = (await indexer.getVtxos({ scripts: [derived.script] })).vtxos.find((v) =>
          v.txid !== funded!.txid && v.commitmentTxIds?.includes(commitment) && !v.isSpent);
        return Boolean(successor);
      }, 60_000);
      expect(successor!.value).toBe(3000);
      expect(successor!.assets ?? []).toEqual(funded!.assets ?? []);
      const restarted = new DbSettlementStore(db, 3_600_000);
      const sweeper = createCovenantSweeper({ contracts, arkServerUrl: ARKD_URL, emulatorUrl: EMULATOR_URL,
        settlements: restarted, renewer });
      expect(restarted.get(paymentHash)!.payoutReference).toBeNull();
      await pollUntil("forwarded renewed payment", async () => {
        await sweeper.sweep();
        return Boolean(restarted.get(paymentHash)?.payoutReference);
      }, 120_000);
      const paid = restarted.get(paymentHash)!;
      expect(paid.paymentReference).toBe(fundedTxid);
      expect(paid.covenantOutpoint).toEqual({ txid: successor!.txid, vout: successor!.vout });
      expect(paid.payoutReference).not.toBe(commitment);
      const outputs = (await indexer.getVtxos({ outpoints: [{ txid: paid.payoutReference!, vout: 0 }] })).vtxos;
      expect(outputs[0]!.value).toBe(3000);
      expect(outputs[0]!.assets ?? []).toEqual(assets);
    } finally {
      if (zeroFee) await setFees(originalFees);
    }
  }, 5 * 60_000);
});
