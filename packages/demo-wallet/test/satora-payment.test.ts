import type { DestinationResult } from "@arkade-os/lnurl-client";
import { bech32m } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSatoraPayments, recoverSatoraPayment, startSatoraPayment, syncSatoraPayment,
} from "../src/satora-payment.js";
import type { SatoraSwapSnapshot } from "../src/satora-sdk.js";
import type { SatoraCheckoutRecord } from "../src/satora-storage.js";

type Adapter = typeof import("../src/satora-sdk.js");
const sdk = vi.hoisted(() => ({
  createSatoraSwap: vi.fn<Adapter["createSatoraSwap"]>(),
  readSatoraSwap: vi.fn<Adapter["readSatoraSwap"]>(),
  readSatoraDeposit: vi.fn<Adapter["readSatoraDeposit"]>(),
  fundSatoraSwap: vi.fn<Adapter["fundSatoraSwap"]>(),
  claimSatoraSwap: vi.fn<Adapter["claimSatoraSwap"]>(),
  recoverSatoraDeposit: vi.fn<Adapter["recoverSatoraDeposit"]>(),
  refundSatoraSwap: vi.fn<Adapter["refundSatoraSwap"]>(),
}));
const records = vi.hoisted(() => new Map<string, SatoraCheckoutRecord>());
vi.mock("../src/satora-sdk.js", () => sdk);
vi.mock("../src/satora-storage.js", () => ({
  getCheckout: async (key: string) => structuredClone(records.get(key)),
  listCheckouts: async () => structuredClone([...records.values()]),
  saveCheckout: async (record: SatoraCheckoutRecord) => { records.set(record.key, structuredClone(record)); },
}));

const AMOUNT_SAT = 125_000;
const SOURCE_AMOUNT = "45000000";
const REFUND_TO = `0x${"99".repeat(20)}`;
const snapshots = new Map<string, SatoraSwapSnapshot>();
const balances = new Map<string, bigint>();

function payout(index: number): DestinationResult {
  const bytes = new Uint8Array(65);
  bytes[64] = index;
  return {
    kind: "destination", paymentOption: "satora",
    paymentDestination: bech32m.encode("ark", bech32m.toWords(bytes), 120),
    verify: `https://lnurl.example.com/lnurl/verify/${index}`,
    verifyBatch: "https://lnurl.example.com/lnurl/verifyBatch",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function updateSwap(key: string, changes: Partial<SatoraSwapSnapshot>): void {
  const { swap } = records.get(key)!;
  snapshots.set(swap!.swapId, { ...snapshots.get(swap!.swapId)!, ...changes });
}

beforeEach(() => {
  vi.resetAllMocks();
  records.clear();
  snapshots.clear();
  balances.clear();
  const queues = new Map<string, Promise<unknown>>();
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal("navigator", { locks: { request: <T>(key: string, task: () => Promise<T>) => {
    const pending = (queues.get(key) ?? Promise.resolve()).then(task);
    queues.set(key, pending.catch(() => undefined));
    return pending;
  } } });

  sdk.createSatoraSwap.mockImplementation(async ({ mnemonic, destination }) => {
    const saved = [...records.values()].find((record) => record.mnemonic === mnemonic);
    expect(saved).toMatchObject({ amountSat: AMOUNT_SAT, payTo: destination });
    expect(saved?.swap).toBeUndefined();
    const index = snapshots.size + 1;
    const swap: SatoraSwapSnapshot = {
      swapId: `swap-${index}`, depositAddress: `0x${index.toString(16).padStart(40, "0")}`,
      sourceAmount: SOURCE_AMOUNT, status: "pending", expiresAt: Date.now() + 900_000,
    };
    snapshots.set(swap.swapId, swap);
    return swap;
  });
  sdk.readSatoraSwap.mockImplementation(async ({ swapId }) => snapshots.get(swapId)!);
  sdk.readSatoraDeposit.mockImplementation(async (address) => balances.get(address) ?? 0n);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("payer-side Satora checkout", () => {
  it("persists a distinct seed per payout and reuses a saved deposit after reload", async () => {
    const answer = payout(1);
    const [first, retried] = await Promise.all([
      startSatoraPayment(answer, AMOUNT_SAT, SOURCE_AMOUNT), startSatoraPayment(answer, AMOUNT_SAT, SOURCE_AMOUNT),
    ]);
    expect(retried.depositAddress).toBe(first.depositAddress);
    expect(sdk.createSatoraSwap).toHaveBeenCalledTimes(1);
    expect(first.canPay).toBe(false);
    expect((await listSatoraPayments())[0]).toMatchObject({ depositAddress: first.depositAddress, canPay: false });
    expect(await syncSatoraPayment(first.key)).toMatchObject({ depositAddress: first.depositAddress, canPay: true });

    const second = await startSatoraPayment(payout(2), AMOUNT_SAT, SOURCE_AMOUNT);
    expect(second.depositAddress).not.toBe(first.depositAddress);
    expect(records.get(second.key)!.mnemonic).not.toBe(records.get(first.key)!.mnemonic);
    expect(records.get(second.key)!.mnemonic.split(" ")).toHaveLength(24);
  });

  it("funds only the exact fresh balance and fences a lost relay acknowledgement", async () => {
    const payment = await startSatoraPayment(payout(1), AMOUNT_SAT, SOURCE_AMOUNT);
    balances.set(payment.depositAddress!, BigInt(SOURCE_AMOUNT) - 1n);
    expect(await syncSatoraPayment(payment.key)).toMatchObject({ canPay: false, canRecover: false });
    expect(sdk.fundSatoraSwap).not.toHaveBeenCalled();

    vi.spyOn(Date, "now").mockReturnValue(payment.expiresAt! + 1);
    balances.set(payment.depositAddress!, 0n);
    expect(await syncSatoraPayment(payment.key)).toMatchObject({ canPay: false, canRecover: false });
    balances.set(payment.depositAddress!, BigInt(SOURCE_AMOUNT));
    sdk.fundSatoraSwap.mockRejectedValueOnce(new Error("Balance changed during preflight"));
    await syncSatoraPayment(payment.key);
    expect(records.get(payment.key)?.funding).toBeUndefined();

    sdk.fundSatoraSwap.mockImplementationOnce(async (_intent, beforeSubmit) => {
      await beforeSubmit?.();
      expect(records.get(payment.key)?.funding).toEqual({});
      throw new Error("Relay response lost");
    });
    const outcomes = await Promise.all([syncSatoraPayment(payment.key), syncSatoraPayment(payment.key)]);
    for (const outcome of outcomes) expect(outcome).toMatchObject({ canPay: false, canRecover: false });
    expect(sdk.fundSatoraSwap).toHaveBeenCalledTimes(2);
    updateSwap(payment.key, { status: "expired" });
    expect(await syncSatoraPayment(payment.key)).toMatchObject({ canPay: false, canRecover: false });
  });

  it("claims only the saved Arkade destination and waits for LNURL confirmation", async () => {
    const payment = await startSatoraPayment(payout(1), AMOUNT_SAT, SOURCE_AMOUNT);
    updateSwap(payment.key, { status: "serverfunded" });
    sdk.claimSatoraSwap.mockResolvedValue("arkade-tx");
    await syncSatoraPayment(payment.key);
    await syncSatoraPayment(payment.key);
    expect(sdk.claimSatoraSwap).toHaveBeenCalledExactlyOnceWith({
      mnemonic: records.get(payment.key)!.mnemonic, swapId: "swap-1", amountSat: AMOUNT_SAT, destination: payment.payTo,
    }, expect.any(Function));
    expect(sdk.readSatoraDeposit).not.toHaveBeenCalled();

    updateSwap(payment.key, { status: "clientredeemed" });
    expect(await syncSatoraPayment(payment.key)).toMatchObject({
      verify: payment.verify, canPay: false, canRecover: false, status: expect.stringMatching(/Waiting for receiver confirmation/),
    });
  });

  it("recovers expired unlocked USDC to the payer's refund address", async () => {
    const payment = await startSatoraPayment(payout(1), AMOUNT_SAT, SOURCE_AMOUNT);
    balances.set(payment.depositAddress!, 123n);
    updateSwap(payment.key, { status: "expired" });
    expect(await syncSatoraPayment(payment.key)).toMatchObject({
      canPay: false, canRecover: true, recoveryKind: "deposit", recoveryNeedsGas: true,
    });
    expect(sdk.fundSatoraSwap).not.toHaveBeenCalled();
    sdk.recoverSatoraDeposit.mockImplementationOnce(async (_intent, to, beforeSubmit) => {
      expect(to).toBe(REFUND_TO);
      await beforeSubmit?.();
      expect(records.get(payment.key)?.recovery).toEqual({ source: "deposit" });
      return "deposit-recovery-tx";
    });
    await expect(recoverSatoraPayment(payment.key, REFUND_TO)).resolves.toBe("deposit-recovery-tx");
    expect(records.get(payment.key)?.recovery).toEqual({ source: "deposit", txId: "deposit-recovery-tx" });
    expect(sdk.refundSatoraSwap).not.toHaveBeenCalled();
  });

  it("uses the contract refund once Satora reports a refundable lock", async () => {
    const payment = await startSatoraPayment(payout(1), AMOUNT_SAT, SOURCE_AMOUNT);
    updateSwap(payment.key, { status: "clientfundedserverrefunded" });
    expect(await syncSatoraPayment(payment.key)).toMatchObject({ canPay: false, canRecover: true, recoveryKind: "contract" });
    sdk.refundSatoraSwap.mockImplementationOnce(async (_intent, beforeSubmit) => {
      await beforeSubmit?.();
      expect(records.get(payment.key)?.recovery).toEqual({ source: "contract" });
      return "contract-refund-tx";
    });
    await expect(recoverSatoraPayment(payment.key)).resolves.toBe("contract-refund-tx");
    expect(sdk.recoverSatoraDeposit).not.toHaveBeenCalled();
    await expect(recoverSatoraPayment(payment.key)).rejects.toThrow(/eligible for recovery/);
  });

  it("resumes a submitted Arkade claim after the browser lost its response", async () => {
    const payment = await startSatoraPayment(payout(1), AMOUNT_SAT, SOURCE_AMOUNT);
    updateSwap(payment.key, { status: "serverfunded" });
    sdk.claimSatoraSwap.mockImplementationOnce(async (_intent, beforeSubmit) => {
      await beforeSubmit?.();
      throw new Error("Claim response lost");
    });
    await syncSatoraPayment(payment.key);

    const claim = records.get(payment.key)!.claim!;
    updateSwap(payment.key, { status: "clientredeeming", claimTxId: "arkade-unfinalized" });
    await syncSatoraPayment(payment.key);
    expect(sdk.claimSatoraSwap).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, "now").mockReturnValue(claim.startedAt + 30_000);
    sdk.claimSatoraSwap.mockResolvedValueOnce("arkade-finalized");
    await syncSatoraPayment(payment.key);
    expect(sdk.claimSatoraSwap).toHaveBeenCalledTimes(2);
    expect(records.get(payment.key)?.claim?.txId).toBe("arkade-finalized");
  });

  it("keeps the QR unusable when Satora changes the deposit details", async () => {
    const payment = await startSatoraPayment(payout(1), AMOUNT_SAT, SOURCE_AMOUNT);
    updateSwap(payment.key, { depositAddress: REFUND_TO });
    expect(await syncSatoraPayment(payment.key)).toMatchObject({
      canPay: false, canRecover: false, status: expect.stringMatching(/Could not verify/),
    });
    expect(sdk.readSatoraDeposit).not.toHaveBeenCalled();
    expect(sdk.fundSatoraSwap).not.toHaveBeenCalled();
  });
});
