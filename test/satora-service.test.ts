import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredSwap } from "@satora/swap";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import type { SatoraIntent, SatoraPayout, SatoraSwapSnapshot } from "../src/rails/satora-sdk.js";
import { SATORA_PAYMENT_OPTION, SatoraCapacityError } from "../src/rails/satora.js";
import { createSatoraService } from "../src/services/satora.js";
import { findSatoraFundingReference, hasPendingSatoraOrders, hasSatoraOrders } from "../src/services/satora-store.js";
import { DbSettlementStore } from "../src/settlement-store.js";

const DEPOSIT = "0x1111111111111111111111111111111111111111";
const REFUND = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const FUND_TX = `0x${"a".repeat(64)}`;
const REFUND_TX = `0x${"b".repeat(64)}`;
const WITHDRAW_TX = `0x${"c".repeat(64)}`;
const CLAIM_TX = "d".repeat(64);
const sourceAmount = "123456";
const amountSat = 1000;
const encryptionKey = Buffer.alloc(32, 17);
type BeforeSubmit = (txId?: string) => Promise<void>;

const handles: Db[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});

function fixture() {
  const db = openDb(":memory:");
  handles.push(db);
  runMigrations(db);
  db.exec(`INSERT INTO domains (id, domain, allocation_modes, created_at, updated_at) VALUES (1, 'pay.example', '[]', 0, 0);
           INSERT INTO addresses (id, domain_id, username, status, created_at, updated_at) VALUES (1, 1, 'alice', 'active', 0, 0);`);
  let now = 1_000;
  let orders = 0;
  let mnemonics = 0;
  const snapshots = new Map<string, SatoraSwapSnapshot>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sdk = {
    generateSatoraMnemonic: vi.fn(() => `mock recovery mnemonic ${++mnemonics}`),
    createSatoraSwap: vi.fn(async (payout: SatoraPayout) => {
      const orderNumber = ++orders;
      const swapId = `order-${orderNumber}`;
      await payout.storage.store({
        swapId, version: 1, targetAddress: payout.destination, publicKey: "mock pubkey", preimage: "mock secret preimage",
        preimageHash: "mock hash", secretKey: "mock secret key", keyIndex: 0, storedAt: now, updatedAt: now,
        response: {} as StoredSwap["response"],
      });
      const depositAddress = orderNumber === 1 ? DEPOSIT : `0x${String(orderNumber).padStart(40, "0")}`;
      const snapshot: SatoraSwapSnapshot = { swapId, depositAddress, sourceAmount, status: "pending", expiresAt: now + 900_000 };
      snapshots.set(swapId, snapshot);
      return snapshot;
    }),
    readSatoraSwap: vi.fn(async (intent: SatoraIntent) => {
      expect(intent.mnemonic).toMatch(/^mock recovery mnemonic \d+$/);
      expect(await intent.storage.get(intent.swapId)).toMatchObject({ preimage: "mock secret preimage", targetAddress: intent.destination });
      return snapshots.get(intent.swapId)!;
    }),
    readSatoraDeposit: vi.fn(async (_address: string) => 0n),
    fundSatoraSwap: vi.fn(async (_intent: SatoraIntent, beforeSubmit?: BeforeSubmit) => {
      await beforeSubmit?.();
      return FUND_TX;
    }),
    claimSatoraSwap: vi.fn(async (_intent: SatoraIntent, beforeSubmit?: BeforeSubmit) => {
      await beforeSubmit?.(CLAIM_TX);
      return CLAIM_TX;
    }),
    continueSatoraClaim: vi.fn(async (_intent: SatoraIntent, _txId: string) => CLAIM_TX),
    recoverSatoraDeposit: vi.fn(async (_intent: SatoraIntent, _address: string, beforeSubmit?: BeforeSubmit) => {
      await beforeSubmit?.(REFUND_TX);
      return REFUND_TX;
    }),
    refundSatoraSwap: vi.fn(async (_intent: SatoraIntent, beforeSubmit?: BeforeSubmit) => {
      await beforeSubmit?.(REFUND_TX);
      return REFUND_TX;
    }),
    readSatoraRecoveryReceipt: vi.fn(async (_hash: string): Promise<"success" | "reverted" | null> => null),
    withdrawSatoraRefund: vi.fn(async (_intent: SatoraIntent, _txId: string, _address: string, beforeSubmit?: BeforeSubmit) => {
      await beforeSubmit?.(WITHDRAW_TX);
      return WITHDRAW_TX;
    }),
    hasFinalizedSatoraRefund: vi.fn(async (_intent: SatoraIntent, _txId: string) => false),
  };
  const restart = () => createSatoraService({ db, encryptionKey, logger, sdk, now: () => now });
  const service = restart();
  const settlements = new DbSettlementStore(db, 3_600_000, () => now);
  const values = (verifyId: string) => ({ addressId: 1, amountSat, verifyId, deriveRecipient: async () => ({ address: `ark-${verifyId}`, script: `script-${verifyId}` }) });
  async function quote(verifyId: string, active = true) {
    const quoted = await service.create(values(verifyId));
    if (active) {
      settlements.create({ paymentHash: verifyId, pr: "", sessionId: "session", addressId: 1, amountMsat: amountSat * 1000,
        paymentOption: SATORA_PAYMENT_OPTION, paymentDestination: quoted.depositAddress, covenantScript: quoted.covenantScript });
      service.activate(quoted.swapId);
    }
    return quoted;
  }
  return { db, service, settlements, logger, sdk, snapshots, restart, values, quote, advance: (ms: number) => { now += ms; } };
}

describe("Satora server orders", () => {
  it("seals each key and SDK state and waits for the matching checkout to be persisted", async () => {
    const f = fixture();
    const unbound = await f.quote("unbound", false);
    expect(() => f.service.activate(unbound.swapId)).toThrow("unavailable");
    expect(hasPendingSatoraOrders(f.db, 1_000)).toBe(false);
    expect(hasSatoraOrders(f.db)).toBe(true);

    f.settlements.create({ paymentHash: "unbound", pr: "", sessionId: "session", addressId: 1, amountMsat: amountSat * 1000,
      paymentOption: SATORA_PAYMENT_OPTION, paymentDestination: DEPOSIT, covenantScript: "unbound-different-script" });
    expect(() => f.service.activate(unbound.swapId)).toThrow("unavailable");
    f.sdk.readSatoraDeposit.mockResolvedValue(BigInt(sourceAmount));
    await f.restart().pollOnce();
    expect(f.sdk.fundSatoraSwap).not.toHaveBeenCalled();

    const active = await f.quote("active");
    expect(active.depositAddress).not.toBe(unbound.depositAddress);
    expect(hasPendingSatoraOrders(f.db, 1_000)).toBe(true);
    const stored = f.db.prepare("SELECT mnemonic, sdk_state FROM satora_orders").all() as { mnemonic: Uint8Array; sdk_state: Uint8Array }[];
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(Buffer.from(row.mnemonic).includes("mock recovery mnemonic")).toBe(false);
      expect(Buffer.from(row.sdk_state).includes("mock secret preimage")).toBe(false);
    }
    const details = await f.restart().inspect("active");
    expect(details).toMatchObject({ swapId: active.swapId, active: true, depositAddress: active.depositAddress });
    expect(JSON.stringify(details)).not.toContain("mock recovery mnemonic");
    expect(() => createSatoraService({ db: f.db, encryptionKey: Buffer.alloc(32, 8), logger: f.logger, sdk: f.sdk })).toThrow();
  });

  it("reserves intake capacity before covenant derivation across service instances", async () => {
    const f = fixture();
    let release!: () => void;
    const awaiting = new Promise<void>((resolve) => { release = resolve; });
    const requests = Array.from({ length: 5 }, (_, index) => {
      const input = f.values(`order-${index}`);
      return f.restart().create({ ...input, deriveRecipient: async () => { await awaiting; return input.deriveRecipient(); } });
    });
    const sixth = vi.fn();
    await expect(f.service.create({ ...f.values("sixth"), deriveRecipient: sixth })).rejects.toBeInstanceOf(SatoraCapacityError);
    expect(sixth).not.toHaveBeenCalled();
    release();
    await expect(Promise.all(requests)).resolves.toHaveLength(5);
  });

  it("only funds an exact deposit and preserves the relay fence through restart and expiry", async () => {
    const f = fixture();
    const quoted = await f.quote("verify");
    for (const invalid of [0n, BigInt(sourceAmount) - 1n, BigInt(sourceAmount) + 1n]) {
      f.sdk.readSatoraDeposit.mockResolvedValue(invalid);
      await f.service.pollOnce();
      f.advance(10_000);
    }
    expect(f.sdk.fundSatoraSwap).not.toHaveBeenCalled();
    f.sdk.readSatoraDeposit.mockResolvedValue(BigInt(sourceAmount));
    const broadcast = vi.fn();
    f.sdk.fundSatoraSwap.mockImplementationOnce(async (_intent, beforeSubmit) => {
      await beforeSubmit?.();
      broadcast();
      throw new Error("provider timeout with private-token response text");
    });
    await Promise.all([f.service.pollOnce(), f.restart().pollOnce()]);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(f.logger.warn).toHaveBeenCalledWith("satora_order_poll_failed", { swapId: quoted.swapId });
    f.advance(10_000);
    await f.restart().pollOnce();
    expect(f.sdk.fundSatoraSwap).toHaveBeenCalledTimes(1);
    f.snapshots.get(quoted.swapId)!.status = "expired";
    f.advance(900_000);
    await expect(f.restart().recover(quoted.swapId, 1, REFUND)).rejects.toThrow("not eligible");
    expect(f.sdk.recoverSatoraDeposit).not.toHaveBeenCalled();
  });

  it("rejects a stale funding worker after an expired deposit recovery is reserved", async () => {
    const f = fixture();
    const quoted = await f.quote("verify");
    f.sdk.readSatoraDeposit.mockResolvedValue(BigInt(sourceAmount));
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const broadcast = vi.fn();
    f.sdk.fundSatoraSwap.mockImplementationOnce(async (_intent, beforeSubmit) => {
      entered();
      await hold;
      await beforeSubmit?.();
      broadcast();
      return FUND_TX;
    });
    const stale = f.service.pollOnce();
    await ready;
    f.advance(901_000);
    f.snapshots.get(quoted.swapId)!.status = "expired";
    await expect(f.restart().recover("verify", 1, REFUND)).resolves.toMatchObject({ kind: "deposit", state: "submitted" });
    f.advance(-901_000);
    release();
    await stale;
    expect(broadcast).not.toHaveBeenCalled();
    expect(f.service.listRecoveryOrders("verify")[0]).toMatchObject({ fundingStarted: false, recoveryTxId: REFUND_TX });
  });

  it("persists the Polygon funding ref and resumes only the prepared Arkade claim", async () => {
    const f = fixture();
    const quoted = await f.quote("verify");
    const snapshot = f.snapshots.get(quoted.swapId)!;
    f.sdk.readSatoraDeposit.mockResolvedValue(BigInt(sourceAmount));
    await f.service.pollOnce();
    expect(findSatoraFundingReference(f.db, "verify")).toBe(FUND_TX);
    snapshot.status = "serverfunded";
    f.sdk.claimSatoraSwap.mockImplementationOnce(async (_intent, beforeSubmit) => {
      await beforeSubmit?.(CLAIM_TX);
      throw new Error("Arkade acknowledgment lost");
    });
    f.advance(10_000);
    await f.service.pollOnce();
    expect(f.service.listRecoveryOrders("verify")[0]).toMatchObject({ claimCandidateTxId: CLAIM_TX, claimTxId: null });
    f.sdk.continueSatoraClaim.mockResolvedValueOnce("f".repeat(64));
    f.advance(10_000);
    await f.restart().pollOnce();
    expect(f.sdk.claimSatoraSwap).toHaveBeenCalledTimes(1);
    expect(f.sdk.continueSatoraClaim).toHaveBeenCalledWith(expect.objectContaining({ destination: "ark-verify" }), CLAIM_TX);
    expect(f.service.listRecoveryOrders("verify")[0]).toMatchObject({ claimCandidateTxId: CLAIM_TX, claimTxId: null });
    snapshot.status = "clientredeeming";
    f.advance(10_000);
    await f.restart().pollOnce();
    expect(f.sdk.continueSatoraClaim).toHaveBeenCalledTimes(2);
    expect(f.service.listRecoveryOrders("verify")[0]).toMatchObject({ claimTxId: CLAIM_TX });
    expect(f.settlements.get("verify")?.settled).toBe(false);
  });

  it("returns an expired unfunded deposit only to the explicit bound Polygon recipient", async () => {
    const f = fixture();
    const quoted = await f.quote("verify");
    f.advance(901_000);
    f.snapshots.get(quoted.swapId)!.status = "expired";
    f.sdk.readSatoraDeposit.mockResolvedValue(BigInt(sourceAmount));
    const submitted = { kind: "deposit", txId: REFUND_TX, state: "submitted" };
    await expect(f.service.recover("verify", 2, REFUND)).rejects.toThrow("was not found for this address");
    await expect(f.service.recover("verify", 1, DEPOSIT)).rejects.toThrow("separate Polygon recovery address");
    await expect(f.service.recover("verify", 1, REFUND)).resolves.toEqual(submitted);
    await expect(f.restart().recover(quoted.swapId, 1, REFUND)).resolves.toEqual(submitted);
    await expect(f.restart().recover(quoted.swapId, 1, OTHER)).rejects.toThrow("already bound");
    f.sdk.readSatoraRecoveryReceipt.mockResolvedValue("success");
    f.sdk.readSatoraDeposit.mockResolvedValue(0n);
    await expect(f.restart().recover("verify", 1, REFUND)).resolves.toEqual({ ...submitted, state: "confirmed" });
    expect(f.sdk.recoverSatoraDeposit).toHaveBeenCalledTimes(1);
    await f.restart().pollOnce();
    expect(f.sdk.fundSatoraSwap).not.toHaveBeenCalled();
  });

  it("proves an ambiguous HTLC refund before withdrawing the returned asset", async () => {
    const f = fixture();
    const quoted = await f.quote("verify");
    const swap = f.snapshots.get(quoted.swapId)!;
    f.sdk.readSatoraDeposit.mockResolvedValue(BigInt(sourceAmount));
    await f.service.pollOnce();
    swap.status = "serverwontfund";
    f.sdk.refundSatoraSwap.mockImplementationOnce(async (_intent, beforeSubmit) => {
      await beforeSubmit?.();
      throw new Error("cooperative refund acknowledgement lost");
    });
    await expect(f.service.recover("verify", 1, REFUND)).rejects.toThrow("Inspect the order");
    swap.status = "clientrefunded";
    swap.refundTxId = REFUND_TX;
    f.sdk.readSatoraRecoveryReceipt.mockResolvedValue("success");
    await expect(f.restart().recover("verify", 1, REFUND)).resolves.toEqual({ kind: "htlc-refund", txId: null, state: "submitting" });
    expect(f.sdk.withdrawSatoraRefund).not.toHaveBeenCalled();
    f.sdk.hasFinalizedSatoraRefund.mockResolvedValue(true);
    await expect(f.restart().recover("verify", 1, REFUND)).resolves.toEqual({ kind: "refunded-asset", txId: WITHDRAW_TX, state: "submitted" });
    expect(f.sdk.refundSatoraSwap).toHaveBeenCalledTimes(1);
    expect(f.sdk.withdrawSatoraRefund).toHaveBeenCalledWith(expect.anything(), REFUND_TX, REFUND, expect.any(Function));
    f.sdk.readSatoraDeposit.mockResolvedValue(0n);
    await expect(f.restart().recover("verify", 1, REFUND)).resolves.toEqual({ kind: "refunded-asset", txId: WITHDRAW_TX, state: "confirmed" });
  });
});
