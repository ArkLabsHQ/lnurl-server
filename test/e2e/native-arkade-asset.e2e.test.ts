import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import request from "supertest";
import { hex } from "@scure/base";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  ArkAddress, ContractManager, EsploraProvider, MnemonicIdentity, RestArkProvider,
  RestIndexerProvider, Wallet, contractHandlers,
} from "@arkade-os/sdk";
import { bootstrap } from "../../src/bootstrap.js";
import { sqliteContractStores } from "../../src/contract-store.js";
import { covenantDestinationHandler } from "../../src/covenant/contract.js";
import { createCovenantDestinationProvider } from "../../src/covenant/destination.js";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories } from "../../src/db/repositories/index.js";
import { createServer } from "../../src/http/server.js";
import { AddressService } from "../../src/services/addresses.js";
import { DbSettlementStore } from "../../src/settlement-store.js";
import { settleDestinationPayments } from "../../src/workers/arkade-watcher.js";
import { createCovenantSweeper } from "../../src/workers/covenant-sweeper.js";
import { catchUp } from "../../src/workers/covenant-watcher.js";
import {
  ARKD_URL, EMULATOR_URL, ESPLORA_URL, REGTEST_DIR, ensureStack, faucet, mine,
  nodeSqliteStorage, pollUntil,
} from "./support/regtest.js";

it("delivers native assets with the receiver offline and verifies only the exact covenant payout", async () => {
  if (!process.env.E2E_REGTEST_ENV) await ensureStack();
  const ark = new RestArkProvider(ARKD_URL);
  const info = await ark.getInfo();
  expect(info.network).toBe("regtest");
  expect((await fetch(`${EMULATOR_URL}/v1/info`)).ok).toBe(true);

  const db = openDb(":memory:");
  let payer: Wallet | undefined;
  let receiver: Wallet | undefined;
  let contracts: ContractManager | undefined;
  try {
    runMigrations(db);
    bootstrap(db, { bootstrapDomain: "localhost" });
    const repos = createRepositories(db);
    const indexer = new RestIndexerProvider(ARKD_URL);
    const settlements = new DbSettlementStore(db, 3_600_000);
    contractHandlers.register(covenantDestinationHandler);
    contracts = await ContractManager.create({ indexerProvider: indexer, ...(await sqliteContractStores(db)) });
    const app = createServer(
      { port: 0, baseUrl: "http://localhost", minSendable: 1000, maxSendable: 100_000_000_000, invoiceTimeoutMs: 30_000 },
      {
        repos,
        addressService: new AddressService(repos, randomBytes(32)),
        settlements,
        network: "regtest",
        arkadeSigner: info.signerPubkey,
        arkDustSat: Number(info.dust),
        arkServerUrl: ARKD_URL,
        covenantDestinations: createCovenantDestinationProvider({
          arkServerUrl: ARKD_URL, emulatorUrl: EMULATOR_URL, recoveryDelaySeconds: 4096, contracts,
        }),
      },
    );
    const http = request(app);

    payer = await fundedWallet(ark);
    const { assetId } = await payer.assetManager.issue({ amount: 1000n });
    await waitForAsset(indexer, await payer.getAddress(), assetId, 1000n);
    receiver = await createWallet(ark);
    const arkadeAddress = await receiver.getAddress();
    const claimPublicKey = hex.encode(await receiver.identity.compressedPublicKey());
    await receiver.dispose();
    receiver = undefined;

    const token = randomBytes(32).toString("hex");
    await http.post("/lnurl/address").set("Host", "localhost").send({ token, username: "alice" }).expect(201);
    await http.post("/lnurl/address/alice/arkade").set("Host", "localhost").set("Authorization", `Bearer ${token}`)
      .send({ arkadeAddress, claimPublicKey, arkadeAssets: [assetId] }).expect(200);

    const domain = repos.domains.getByDomain("localhost")!;
    const alias = repos.addresses.getByDomainAndUsername(domain.id, "alice")!;
    repos.addresses.setDisabledRails(alias.id, ["covenant"]);
    const btcAmount = Number(info.dust);
    const { body: btc } = await http.get(`/.well-known/lnurlp/alice/callback?amount=${btcAmount * 1000}&paymentOption=arkade`)
      .set("Host", "localhost").expect(200);
    expect(btc).toMatchObject({ paymentOption: "arkade", paymentDestination: arkadeAddress });
    const [pendingBtc] = settlements.listPendingDestinations();
    expect(pendingBtc?.amountMsat).toBe(btcAmount * 1000);
    repos.addresses.setDisabledRails(alias.id, []);

    const { body: payRequest } = await http.get("/.well-known/lnurlp/alice").set("Host", "localhost").expect(200);
    const option = payRequest.paymentOptions.find((entry: { type: string }) => entry.type === "arkade-asset");
    expect(option).toMatchObject({ assetId, verifiable: true, caip19Id: `arkade:regtest/asset:${assetId}` });
    const instructions = async (receipt?: true) => {
      const { body } = await http.post(pathOf(option.assetCallback)).set("Host", "localhost")
        .send({ assetId, amount: "100", receipt }).expect(200);
      expect(body).toMatchObject({ status: "OK", paymentOption: option.id, assetId, assetAmount: "100", network: "regtest" });
      return body as { paymentDestination: string; verify?: string };
    };

    const direct = await instructions();
    expect(direct.paymentDestination).toBe(arkadeAddress);
    expect(direct.verify).toBeUndefined();
    const directTxid = await payer.send({ address: direct.paymentDestination, assets: [{ assetId, amount: 100n }] });
    await waitForAsset(indexer, arkadeAddress, assetId, 100n, directTxid);
    expect(await settleDestinationPayments(settlements, indexer)).toBe(0);
    expect(settlements.get(pendingBtc!.paymentHash)?.settled).toBe(false);
    const btcTxid = await payer.send({ address: arkadeAddress, amount: btcAmount });
    await pollUntil("static BTC payment settled", async () => {
      await settleDestinationPayments(settlements, indexer);
      return settlements.get(pendingBtc!.paymentHash)?.paymentReference === btcTxid;
    }, 60_000);

    const unpaid = await instructions(true);
    const paid = await instructions(true);
    expect(unpaid.paymentDestination).not.toBe(paid.paymentDestination);
    expect(paid.paymentDestination).not.toBe(arkadeAddress);
    const verifyPath = pathOf(paid.verify!);
    const verify = () => http.get(verifyPath).set("Host", "localhost").expect(200);
    expect((await verify()).body).toMatchObject({ settled: false, assetId, assetAmount: "100" });

    const shortTxid = await payer.send({ address: paid.paymentDestination, assets: [{ assetId, amount: 99n }] });
    await waitForAsset(indexer, paid.paymentDestination, assetId, 99n, shortTxid);
    await catchUp(settlements, contracts);
    expect((await verify()).body.settled).toBe(false);

    const exactTxid = await payer.send({ address: paid.paymentDestination, assets: [{ assetId, amount: 100n }] });
    await waitForAsset(indexer, paid.paymentDestination, assetId, 100n, exactTxid);
    await catchUp(settlements, contracts);
    expect((await verify()).body.settled).toBe(false);

    const reopenedStore = new DbSettlementStore(db, 3_600_000);
    const sweeper = createCovenantSweeper({
      contracts, indexer, arkProvider: ark, arkServerUrl: ARKD_URL, emulatorUrl: EMULATOR_URL, settlements: reopenedStore,
    });
    await pollUntil("verified indexed asset payout", async () => {
      await sweeper.sweep();
      return (await verify()).body.settled === true;
    }, 120_000);
    const receiptId = verifyPath.split("/").at(-1)!;
    const recorded = reopenedStore.get(receiptId)!;
    expect(recorded?.payoutReference).toBeTruthy();
    const credited = (await verify()).body;
    expect(credited).toMatchObject({ settled: true, assetId, assetAmount: "100", paymentReference: exactTxid });
    await waitForAsset(indexer, arkadeAddress, assetId, 100n, recorded.payoutReference!);
    expect((await http.get(pathOf(unpaid.verify!)).set("Host", "localhost").expect(200)).body.settled).toBe(false);

    const duplicateTxid = await payer.send({ address: paid.paymentDestination, assets: [{ assetId, amount: 100n }] });
    await waitForAsset(indexer, paid.paymentDestination, assetId, 100n, duplicateTxid);
    const covenantScript = hex.encode(ArkAddress.decode(paid.paymentDestination).pkScript);
    let duplicatePayoutTxid: string | undefined;
    await pollUntil("additional assets forwarded from the paid destination", async () => {
      await sweeper.sweep();
      const { vtxos } = await indexer.getVtxos({ scripts: [covenantScript] });
      duplicatePayoutTxid = vtxos.find((coin) => coin.txid === duplicateTxid && coin.isSpent)?.arkTxId;
      return Boolean(duplicatePayoutTxid);
    }, 120_000);
    expect(duplicatePayoutTxid).not.toBe(recorded.payoutReference);
    await waitForAsset(indexer, arkadeAddress, assetId, 100n, duplicatePayoutTxid!);
    expect((await verify()).body).toEqual(credited);
    expect(reopenedStore.get(receiptId)?.payoutReference).toBe(recorded.payoutReference);
  } finally {
    contracts?.dispose();
    await payer?.dispose();
    await receiver?.dispose();
    db.close();
  }
}, 30 * 60_000);

function pathOf(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

async function createWallet(ark: RestArkProvider): Promise<Wallet> {
  return Wallet.create({
    identity: MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist), { isMainnet: false }),
    arkProvider: ark,
    onchainProvider: new EsploraProvider(ESPLORA_URL),
    storage: await nodeSqliteStorage(":memory:"),
    settlementConfig: false,
  });
}

async function fundedWallet(ark: RestArkProvider): Promise<Wallet> {
  const wallet = await createWallet(ark);
  try {
    const boarding = await wallet.getBoardingAddress();
    const env = process.env.E2E_REGTEST_ENV;
    if (env) {
      const command = (...args: string[]) => execFileSync(process.execPath,
        [join(REGTEST_DIR, "regtest.mjs"), ...args, "--env", resolve(env)], { stdio: "pipe", timeout: 60_000 });
      command("faucet", boarding, "0.002", "--confirm");
    } else {
      await faucet(boarding, "0.002");
      await mine(1);
    }
    await pollUntil("confirmed payer deposit", async () =>
      (await wallet.getBoardingUtxos()).some((coin) => coin.status.confirmed), 60_000);
    await wallet.settle();
    return wallet;
  } catch (err) {
    await wallet.dispose();
    throw err;
  }
}

async function waitForAsset(indexer: RestIndexerProvider, address: string, assetId: string, amount: bigint, txid?: string): Promise<void> {
  const script = hex.encode(ArkAddress.decode(address).pkScript);
  await pollUntil(`indexed transfer of ${amount} units`, async () => {
    const { vtxos } = await indexer.getVtxos({ scripts: [script] });
    return vtxos.some((coin) => (!txid || coin.txid === txid) &&
      coin.assets?.some((asset) => asset.assetId === assetId && asset.amount === amount));
  }, 60_000);
}
