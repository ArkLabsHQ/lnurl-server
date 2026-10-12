import { describe, it, expect } from "vitest";
import { MemorySettlementStore, DbSettlementStore } from "../src/settlement-store.js";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { base64, hex } from "@scure/base";
import { Transaction, ArkAddress, type VirtualCoin, type IndexerProvider } from "@arkade-os/sdk";
import { reconcileCovenantForwarding } from "../src/covenant/forwarding.js";

const outpoint = { txid: "11".repeat(32), vout: 2 };
const next = { txid: "22".repeat(32), vout: 0 };
const receipt = { paymentHash: "h", pr: "", sessionId: "s", paymentOption: "arkade", covenantScript: "5120aa", amountMsat: 2_000_000 };

const destination = "tark1qpf3lesxsy69q0f8yvfnyf7gv7kglfkg83fhaxjyc0zmm0wtrl3n0zknt6dcdl6z326wzf0z06cmkpt3fh9c9f5f4s0ypeek7n8umsfgt0g0l3";
const coin = (point = outpoint, extra: Partial<VirtualCoin> = {}): VirtualCoin => ({
  ...point, value: 2000, script: receipt.covenantScript, createdAt: new Date(), status: { confirmed: false },
  isSpent: false, isSwept: false, isUnrolled: false, assets: [], ...extra,
});

describe("covenant forwarding reconciliation", () => {
  const setup = () => {
    const store = new MemorySettlementStore(3_600_000);
    store.create(receipt);
    store.markObserved("h", outpoint.txid);
    store.setCovenantOutpoint("h", outpoint, null);
    return store;
  };

  it("adopts a successor from the exact renewal commitment without declaring payout", async () => {
    const store = setup();
    const commitment = "33".repeat(32);
    await reconcileCovenantForwarding(store, receipt.covenantScript, destination, [
      coin(outpoint, { isSpent: true, settledBy: commitment }),
      coin(next, { commitmentTxIds: [commitment] }),
    ], {} as IndexerProvider);
    expect(store.get("h")).toMatchObject({ covenantOutpoint: next, paymentReference: outpoint.txid, payoutReference: null });
  });

  it("rejects an unrelated matching deposit and an ambiguous successor", async () => {
    const commitment = "33".repeat(32);
    const predecessor = coin(outpoint, { isSpent: true, settledBy: commitment });
    for (const candidates of [
      [coin(next, { commitmentTxIds: ["44".repeat(32)] })],
      [coin(next, { commitmentTxIds: [commitment] }), coin({ txid: "55".repeat(32), vout: 0 }, { commitmentTxIds: [commitment] })],
    ]) {
      const store = setup();
      await expect(reconcileCovenantForwarding(store, receipt.covenantScript, destination, [predecessor, ...candidates], {} as IndexerProvider)).rejects.toThrow(/successor/);
      expect(store.get("h")).toMatchObject({ covenantOutpoint: outpoint, payoutReference: null });
    }
  });

  it("follows a renewed output already forwarded during downtime and validates its payout", async () => {
    const store = setup();
    const commitment = "33".repeat(32);
    const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
    tx.addInput({ txid: next.txid, index: next.vout });
    tx.addOutput({ script: ArkAddress.decode(destination).pkScript, amount: 2000n });
    const paidCoin = coin({ txid: tx.id, vout: 0 }, { script: hex.encode(ArkAddress.decode(destination).pkScript) });
    const provider = {
      getVirtualTxs: async () => ({ txs: [base64.encode(tx.toPSBT())] }),
      getVtxos: async () => ({ vtxos: [paidCoin] }),
    } as unknown as IndexerProvider;
    await reconcileCovenantForwarding(store, receipt.covenantScript, destination, [
      coin(outpoint, { isSpent: true, settledBy: commitment }),
      coin(next, { isSpent: true, commitmentTxIds: [commitment], arkTxId: tx.id }),
    ], provider);
    expect(store.get("h")).toMatchObject({ covenantOutpoint: next, payoutReference: tx.id, paymentReference: outpoint.txid });
  });

  it("refuses payout evidence for a different recipient or reduced value", async () => {
    for (const output of [{ script: new Uint8Array([0x6a]), amount: 2000n }, { script: ArkAddress.decode(destination).pkScript, amount: 1999n }]) {
      const store = setup();
      const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
      tx.addInput({ txid: outpoint.txid, index: outpoint.vout });
      tx.addOutput(output);
      const provider = { getVirtualTxs: async () => ({ txs: [base64.encode(tx.toPSBT())] }) } as unknown as IndexerProvider;
      await expect(reconcileCovenantForwarding(store, receipt.covenantScript, destination, [coin(outpoint, { isSpent: true, arkTxId: tx.id })], provider)).rejects.toThrow(/payout/);
      expect(store.get("h")!.payoutReference).toBeNull();
    }
  });
});

describe("covenant outpoint persistence", () => {
  it("keeps the original receipt while advancing the forwarding outpoint", () => {
    const store = new MemorySettlementStore(3_600_000);
    store.create(receipt);
    store.markObserved("h", outpoint.txid);
    expect(store.setCovenantOutpoint("h", outpoint, null)).toBe(true);
    expect(store.setCovenantOutpoint("h", next, outpoint)).toBe(true);
    expect(store.setCovenantOutpoint("h", outpoint, outpoint)).toBe(false);
    expect(store.get("h")).toMatchObject({ paymentReference: outpoint.txid, covenantOutpoint: next, payoutReference: null });
  });

  it("retains the successor across database store restart", () => {
    const db = openDb(":memory:");
    try {
      runMigrations(db);
      const store = new DbSettlementStore(db, 3_600_000);
      store.create(receipt);
      store.markObserved("h", outpoint.txid);
      expect(store.setCovenantOutpoint("h", next, null)).toBe(true);
      expect(new DbSettlementStore(db, 3_600_000).get("h")).toMatchObject({ covenantOutpoint: next, paymentReference: outpoint.txid });
    } finally {
      db.close();
    }
  });
});
