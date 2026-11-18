import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredSwap } from "@satora/swap";
import { createHmac } from "node:crypto";
import { base58 } from "@scure/base";
import { encryptToken } from "../src/crypto.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import type { SatoraCctpBurn, SatoraEnsureGas, SatoraIntent, SatoraPayout, SatoraSwapSnapshot } from "../src/rails/satora-sdk.js";
import type { SolanaFeeSponsor } from "../src/rails/satora-solana.js";
import { SATORA_SOURCES, type SatoraSource } from "../src/rails/satora-catalogue.js";
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
type BeforeSubmit = (txId?: string, cctpBurn?: SatoraCctpBurn) => Promise<void>;

const handles: Db[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});

function fixture(setup?: (db: Db) => void) {
  const db = openDb(":memory:");
  handles.push(db);
  setup?.(db);
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
      const depositAddress = payout.source.type === "solana" ? base58.encode(Buffer.alloc(32, orderNumber))
        : orderNumber === 1 ? DEPOSIT : `0x${String(orderNumber).padStart(40, "0")}`;
      const snapshot: SatoraSwapSnapshot = { swapId, depositAddress, sourceAmount, status: "pending", expiresAt: now + 900_000 };
      snapshots.set(swapId, snapshot);
      return snapshot;
    }),
    readSatoraSwap: vi.fn(async (intent: SatoraIntent) => {
      expect(intent.mnemonic).toMatch(/^mock recovery mnemonic \d+$/);
      expect(await intent.storage.get(intent.swapId)).toMatchObject({ preimage: "mock secret preimage", targetAddress: intent.destination });
      return snapshots.get(intent.swapId)!;
    }),
    readSatoraDeposit: vi.fn(async (_address: string, _source: SatoraSource) => 0n),
    fundSatoraSwap: vi.fn(async (_intent: SatoraIntent, beforeSubmit?: BeforeSubmit) => {
      await beforeSubmit?.();
      return FUND_TX;
    }),
    resumeSatoraFunding: vi.fn(async (_intent: SatoraIntent): Promise<string | undefined> => FUND_TX),
    canRecoverUnburnedSatoraFunding: vi.fn(async (_intent: SatoraIntent) => false),
    hasFinalizedSatoraBridgeRecovery: vi.fn(async (_intent: SatoraIntent, _txId: string, _recipient: string) => false),
    recoverSatoraBridgedDeposit: vi.fn(async (_intent: SatoraIntent, _address: string, beforeSubmit?: BeforeSubmit) => {
      await beforeSubmit?.(REFUND_TX);
      return REFUND_TX;
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
    readSatoraRecoveryReceipt: vi.fn(async (_hash: string, _source: SatoraSource, _settlementChain?: boolean): Promise<"success" | "reverted" | null> => null),
    withdrawSatoraRefund: vi.fn(async (_intent: SatoraIntent, _txId: string, _address: string, beforeSubmit?: BeforeSubmit) => {
      await beforeSubmit?.(WITHDRAW_TX);
      return WITHDRAW_TX;
    }),
    hasFinalizedSatoraRefund: vi.fn(async (_intent: SatoraIntent, _txId: string) => false),
  };
  const restart = (ensureGas?: SatoraEnsureGas, checkGas?: (source: SatoraSource) => Promise<void>, solanaSponsor?: SolanaFeeSponsor) =>
    createSatoraService({ db, encryptionKey, logger, sdk, now: () => now, ensureGas, checkGas, solanaSponsor });
  const service = restart();
  const settlements = new DbSettlementStore(db, 3_600_000, () => now);
  const values = (verifyId: string, optionId = SATORA_PAYMENT_OPTION) => ({
    addressId: 1, amountSat, verifyId, optionId,
    deriveRecipient: async () => ({ address: `ark-${verifyId}`, script: `script-${verifyId}` }),
  });
  async function quote(verifyId: string, active = true, optionId = SATORA_PAYMENT_OPTION) {
    const quoted = await service.create(values(verifyId, optionId));
    if (active) {
      settlements.create({ paymentHash: verifyId, pr: "", sessionId: "session", addressId: 1, amountMsat: amountSat * 1000,
        paymentOption: optionId, paymentDestination: quoted.depositAddress, covenantScript: quoted.covenantScript });
      service.activate(quoted.swapId);
    }
    return quoted;
  }
  return { db, service, settlements, logger, sdk, snapshots, restart, values, quote, advance: (ms: number) => { now += ms; } };
}

describe("Satora server orders", () => {
  it("resumes a Polygon order encrypted before payment options were recorded", async () => {
    const legacyId = "order-legacy";
    const legacyVerifyId = "verify-legacy";
    const seal = (scope: string, value: string) => {
      const key = createHmac("sha256", encryptionKey)
        .update(JSON.stringify(["satora", scope, legacyId, legacyVerifyId, 1, amountSat])).digest();
      const { ciphertext, iv, tag } = encryptToken(value, key);
      return Buffer.concat([iv, tag, ciphertext]);
    };
    const f = fixture((db) => {
      runMigrations(db, { upToVersion: 33 });
      db.prepare(`
        INSERT INTO satora_orders(id, verify_id, address_id, amount_sat, mnemonic, sdk_state, destination, swap_id,
          deposit_address, source_amount, provider_status, created_at, expires_at, next_poll_at)
        VALUES (?, ?, 1, ?, ?, ?, 'ark-legacy', ?, ?, ?, 'pending', 1000, 901000, 1000)
      `).run(legacyId, legacyVerifyId, amountSat, seal("mnemonic", "mock recovery mnemonic 1"),
        seal("sdk", JSON.stringify({ preimage: "mock secret preimage", targetAddress: "ark-legacy" })),
        legacyId, DEPOSIT, sourceAmount);
    });
    f.snapshots.set(legacyId, { swapId: legacyId, depositAddress: DEPOSIT, sourceAmount, status: "pending", expiresAt: 901_000 });
    await expect(f.restart().inspect(legacyVerifyId)).resolves.toMatchObject({
      paymentOption: SATORA_PAYMENT_OPTION,
      asset: expect.stringMatching(/^eip155:137\//),
    });
    expect(f.sdk.readSatoraDeposit).toHaveBeenCalledWith(DEPOSIT, expect.objectContaining({ id: SATORA_PAYMENT_OPTION }), undefined);
  });

  it("pins the payment option to the checkout and the encrypted order across restart", async () => {
    const f = fixture();
    const source = SATORA_SOURCES.find((candidate) => candidate.id !== SATORA_PAYMENT_OPTION &&
      candidate.type === "eip155" && candidate.mode === "direct" && candidate.gas !== "native")!;
    const quote = await f.quote("verify", false, source.id);
    f.settlements.create({ paymentHash: "verify", pr: "", sessionId: "session", addressId: 1, amountMsat: amountSat * 1000,
      paymentOption: SATORA_PAYMENT_OPTION, paymentDestination: quote.depositAddress, covenantScript: quote.covenantScript });
    expect(() => f.service.activate(quote.swapId)).toThrow("unavailable");
    f.db.prepare("UPDATE settlements SET payment_option = ? WHERE payment_hash = 'verify'").run(source.id);
    f.service.activate(quote.swapId);
    f.sdk.readSatoraDeposit.mockResolvedValue(BigInt(sourceAmount));
    await f.restart().pollOnce();
    expect(f.sdk.fundSatoraSwap).toHaveBeenCalledWith(expect.objectContaining({ source }), expect.any(Function));
    expect(findSatoraFundingReference(f.db, "verify")).toBe(FUND_TX);
    await expect(f.restart().inspect("verify")).resolves.toMatchObject({ paymentOption: source.id, asset: source.asset });

    f.db.prepare("UPDATE satora_orders SET payment_option = ? WHERE verify_id = 'verify'").run(SATORA_PAYMENT_OPTION);
    expect(() => f.restart()).toThrow();
  });

  it("reserves a native-fee route only when a sponsor is available", async () => {
    const f = fixture();
    const source = SATORA_SOURCES.find((candidate) => candidate.mode === "direct" && candidate.gas === "native")!;
    const input = f.values("native-fee", source.id);
    expect(f.service.isAvailable(source.id)).toBe(false);
    await expect(f.service.create(input)).rejects.toThrow("currently unavailable");
    expect(f.sdk.createSatoraSwap).not.toHaveBeenCalled();
    expect(hasSatoraOrders(f.db)).toBe(false);
    const ensureGas = vi.fn<SatoraEnsureGas>();
    const checkGas = vi.fn<(source: SatoraSource) => Promise<void>>().mockRejectedValueOnce(new Error("insufficient gas"));
    const resumed = f.restart(ensureGas, checkGas);
    expect(resumed.isAvailable(source.id)).toBe(true);
    await expect(resumed.create(input)).rejects.toThrow("currently unavailable");
    expect(f.sdk.createSatoraSwap).not.toHaveBeenCalled();
    expect(checkGas).toHaveBeenCalledWith(source);
    await expect(resumed.create(input)).resolves.toMatchObject({ depositAddress: DEPOSIT });
    expect(f.sdk.createSatoraSwap).toHaveBeenCalledWith(expect.objectContaining({ source, ensureGas }));
  });

  it("persists one authenticated source burn before dispatch and resumes it after a restart", async () => {
    const f = fixture();
    const source = SATORA_SOURCES.find((candidate) => candidate.mode === "cctp" && candidate.type === "eip155")!;
    const service = f.restart(vi.fn<SatoraEnsureGas>());
    const { swapId, depositAddress, covenantScript } = await service.create(f.values("bridge", source.id));
    f.settlements.create({ paymentHash: "bridge", pr: "", sessionId: "session", addressId: 1, amountMsat: amountSat * 1000,
      paymentOption: source.id, paymentDestination: depositAddress, covenantScript });
    service.activate(swapId);
    f.sdk.readSatoraDeposit.mockResolvedValue(BigInt(sourceAmount));
    const burn = { hash: FUND_TX, raw: `0x${"42".repeat(64)}` };
    f.sdk.fundSatoraSwap.mockImplementationOnce(async (_intent, beforeSubmit) => {
      await beforeSubmit?.(burn.hash, burn);
      const saved = f.db.prepare("SELECT cctp_burn, fund_started FROM satora_orders WHERE verify_id = 'bridge'").get() as
        { cctp_burn: Uint8Array; fund_started: number };
      expect(saved.fund_started).toBe(1);
      expect(Buffer.from(saved.cctp_burn).includes(burn.raw)).toBe(false);
      throw new Error("burn receipt acknowledgement lost");
    });
    await service.pollOnce();
    f.advance(10_000);
    await f.restart().pollOnce();
    expect(f.sdk.fundSatoraSwap).toHaveBeenCalledTimes(1);
    expect(f.sdk.resumeSatoraFunding).toHaveBeenCalledWith(expect.objectContaining({ cctpBurn: burn, source }));
    expect(findSatoraFundingReference(f.db, "bridge")).toBe(FUND_TX);

    f.snapshots.get(swapId)!.status = "expired";
    f.sdk.recoverSatoraBridgedDeposit.mockImplementationOnce(async (_intent, _recipient, beforeSubmit) => {
      await beforeSubmit?.();
      throw new Error("Arbitrum rescue acknowledgement lost");
    });
    await expect(f.restart().recover("bridge", 1, REFUND)).rejects.toThrow("Inspect the order");
    await expect(f.restart().recover("bridge", 1, OTHER)).rejects.toThrow("already bound");
    await expect(f.restart().recover("bridge", 1, REFUND)).resolves.toMatchObject({ kind: "bridged-asset", state: "submitting" });
    expect(f.sdk.recoverSatoraBridgedDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ cctpBurn: burn, source }), REFUND, expect.any(Function),
    );
    expect(f.sdk.recoverSatoraBridgedDeposit).toHaveBeenCalledTimes(1);
    f.advance(300_001);
    f.sdk.recoverSatoraBridgedDeposit.mockRejectedValueOnce(new Error("no positive smart account balance proof"));
    await expect(f.restart().recover("bridge", 1, REFUND)).resolves.toMatchObject({ state: "submitting" });
    const broadcast = vi.fn();
    f.sdk.recoverSatoraBridgedDeposit.mockImplementation(async (intent, recipient, beforeSubmit) => {
      expect(intent.retryBridgeRecovery).toBe(true);
      expect(recipient).toBe(REFUND);
      await beforeSubmit?.();
      broadcast();
      throw new Error("Arbitrum acknowledgement still unknown");
    });
    await Promise.all([f.restart().recover("bridge", 1, REFUND), f.restart().recover("bridge", 1, REFUND)]);
    expect(broadcast).toHaveBeenCalledTimes(1);
    await expect(f.restart().reconcileBridgeRecovery("bridge", REFUND_TX)).rejects.toThrow("does not prove");
    f.sdk.hasFinalizedSatoraBridgeRecovery.mockResolvedValue(true);
    await expect(f.restart().reconcileBridgeRecovery("bridge", REFUND_TX)).resolves.toMatchObject({
      recoveryKind: "bridged-asset", recoveryState: "confirmed", recoveryTxId: REFUND_TX, bridgeRecoveryAddress: REFUND,
    });
    expect(f.sdk.hasFinalizedSatoraBridgeRecovery).toHaveBeenLastCalledWith(expect.objectContaining({ source }), REFUND_TX, REFUND);
    await expect(f.restart().reconcileBridgeRecovery("bridge", WITHDRAW_TX)).rejects.toThrow("already bound");
  });

  it("returns an expired unsent Solana burn only after its source balance is proved recoverable", async () => {
    const f = fixture();
    const source = SATORA_SOURCES.find((candidate) => candidate.type === "solana")!;
    const sponsor: SolanaFeeSponsor = {
      rpcUrl: "https://solana.example",
      connection: {} as SolanaFeeSponsor["connection"],
      verifyNetwork: vi.fn(),
      checkGas: vi.fn(),
      ensureGas: vi.fn(),
    };
    const service = f.restart(undefined, undefined, sponsor);
    const { swapId, depositAddress, covenantScript } = await service.create(f.values("solana", source.id));
    f.settlements.create({ paymentHash: "solana", pr: "", sessionId: "session", addressId: 1, amountMsat: amountSat * 1000,
      paymentOption: source.id, paymentDestination: depositAddress, covenantScript });
    service.activate(swapId);
    const burn = { hash: base58.encode(Buffer.alloc(64, 5)), raw: Buffer.alloc(80, 5).toString("base64"), lastValidBlockHeight: 20 };
    f.sdk.fundSatoraSwap.mockImplementationOnce(async (_intent, beforeSubmit) => {
      await beforeSubmit?.(burn.hash, burn);
      throw new Error("burn was never sent");
    });
    f.sdk.readSatoraDeposit.mockResolvedValue(BigInt(sourceAmount));
    await service.pollOnce();
    f.advance(901_000);
    f.snapshots.get(swapId)!.status = "expired";
    f.sdk.readSatoraDeposit.mockResolvedValue(7n);
    f.sdk.canRecoverUnburnedSatoraFunding.mockResolvedValue(true);
    await expect(service.recover("solana", 1, REFUND)).rejects.toThrow("address on the payment chain");
    expect(f.sdk.recoverSatoraDeposit).not.toHaveBeenCalled();
    const recipient = base58.encode(Buffer.alloc(32, 2));
    const signature = base58.encode(Buffer.alloc(64, 3));
    f.sdk.recoverSatoraDeposit.mockImplementationOnce(async (_intent, _recipient, beforeSubmit) => {
      await beforeSubmit?.(signature);
      return signature;
    });
    await expect(service.recover("solana", 1, recipient)).resolves.toMatchObject({ kind: "deposit", txId: signature });
    expect(f.sdk.canRecoverUnburnedSatoraFunding).toHaveBeenCalledWith(expect.objectContaining({ cctpBurn: burn }));
    expect(f.sdk.recoverSatoraBridgedDeposit).not.toHaveBeenCalled();
    expect(f.sdk.recoverSatoraDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ source, solanaSponsor: sponsor }), recipient, expect.any(Function),
    );
    f.sdk.readSatoraRecoveryReceipt.mockResolvedValue("success");
    f.sdk.readSatoraDeposit.mockResolvedValue(0n);
    await expect(service.recover("solana", 1, recipient)).resolves.toMatchObject({ state: "confirmed" });
    expect(f.sdk.readSatoraRecoveryReceipt).toHaveBeenCalledWith(signature, source, false, sponsor);
  });

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
    expect(f.logger.warn).toHaveBeenCalledWith("satora_order_poll_failed", {
      swapId: quoted.swapId, paymentOption: SATORA_PAYMENT_OPTION, stage: "funding",
    });
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
    await expect(f.service.recover("verify", 1, DEPOSIT)).rejects.toThrow("separate recovery address");
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
