import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ArkAddress, ContractManager, RestIndexerProvider, toXOnly } from "@arkade-os/sdk";
import { receiveVtxoScript, registerLockupContract, unilateralClaimDelay, SWAP_LOCKUP_CONTRACT_TYPE } from "@arkade-os/swap";
import { sqliteContractStores } from "../src/contract-store.js";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";

// The half the unit tests fake: a real VHTLC.ScriptV2 through a real ContractManager
// over the real SQLite contract store. createContract re-derives the script from the
// params it is handed and refuses a row that does not reproduce it, so a serialization
// drift would leave every quote unwatched and only the poller claiming.

const operatorXonly = toXOnly(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true), "operator");
const emulatorXonly = toXOnly(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true), "emulator");
const solverXonly = toXOnly(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true), "solver");
const payoutXonly = toXOnly(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true), "payout");

let indexer: { baseUrl: string; close: () => Promise<void> };

/** An indexer with nothing in it — registration is a local write, so no data is needed. */
function emptyIndexer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ vtxos: [], page: null, txs: [], chains: [] }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

function lockup() {
  const preimage = randomBytes(32);
  return receiveVtxoScript({
    solverPubkey: solverXonly,
    refundLocktime: Math.floor(Date.now() / 1000) + 7200,
    serverPubkey: operatorXonly,
    paymentHash: createHash("sha256").update(preimage).digest("hex"),
    claimDelay: unilateralClaimDelay(86_400),
    emulatorPubkey: emulatorXonly,
    solverRefundPkScript: new Uint8Array([0x51, 0x20, ...secp256k1.utils.randomSecretKey()]),
    payoutPubkey: payoutXonly,
    payoutPkScript: ArkAddress.decode(new ArkAddress(operatorXonly, payoutXonly, "tark").encode()).pkScript,
  });
}

beforeAll(async () => { indexer = await emptyIndexer(); });
afterAll(async () => { await indexer.close(); });

describe("registerLockupContract", () => {
  it("writes a row the watcher can match a funding event against", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const contracts = await ContractManager.create({
      indexerProvider: new RestIndexerProvider(indexer.baseUrl),
      ...(await sqliteContractStores(db)),
    });
    const script = lockup();
    const address = script.address("tark", operatorXonly).encode();

    await registerLockupContract(contracts, script, address);

    const rows = await contracts.getContracts({ type: SWAP_LOCKUP_CONTRACT_TYPE });
    expect(rows).toHaveLength(1);
    // The event's `contractScript` is this row's key, and src/lockup-watcher.ts derives
    // its side of the match from the stored lockup address. They have to agree.
    expect(rows[0]!.script).toBe(hex.encode(ArkAddress.decode(address).pkScript));
    contracts.dispose();
    db.close();
  });

  it("is safe to repeat, since a restart re-quotes nothing", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const contracts = await ContractManager.create({
      indexerProvider: new RestIndexerProvider(indexer.baseUrl),
      ...(await sqliteContractStores(db)),
    });
    const script = lockup();
    const address = script.address("tark", operatorXonly).encode();

    await registerLockupContract(contracts, script, address);
    await registerLockupContract(contracts, script, address);

    expect(await contracts.getContracts({ type: SWAP_LOCKUP_CONTRACT_TYPE })).toHaveLength(1);
    contracts.dispose();
    db.close();
  });
});
