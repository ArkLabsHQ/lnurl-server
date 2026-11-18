import { satoraPaymentTarget, type InvoiceResult } from "@arkade-os/lnurl-client";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { SatoraIntent, SatoraSwapSnapshot } from "./satora-sdk.js";
import { getCheckout, listCheckouts, saveCheckout, type SatoraCheckoutRecord } from "./satora-storage.js";

export interface SatoraPayment {
  key: string;
  label?: string;
  amountSat: number;
  payTo: string;
  verify: string;
  verifyBatch?: string;
  expiresAt?: number;
  depositAddress?: string;
  sourceAmount?: string;
  status: string;
  canPay: boolean;
  canRecover: boolean;
  recoveryKind?: "deposit" | "contract";
  recoveryNeedsGas?: boolean;
}

type Observation = { swap: SatoraSwapSnapshot; balance?: bigint };
const REFUNDABLE = new Set(["clientfundedserverrefunded", "clientinvalidfunded", "clientfundedtoolate", "serverwontfund"]);
const PAID_OUT = new Set(["clientredeemed", "serverredeemed", "clientredeemedandclientrefunded"]);
const REFUNDED = new Set(["clientrefunded", "clientrefundedserverfunded", "clientrefundedserverrefunded"]);
const CLAIM_RETRY_MS = 30_000;

function browserLocks(): LockManager {
  if (typeof indexedDB === "undefined" || typeof navigator === "undefined" || !navigator.locks) {
    throw new Error("Satora checkout needs a browser with local storage and Web Locks");
  }
  return navigator.locks;
}

function intentFor(record: SatoraCheckoutRecord): SatoraIntent {
  if (!record.swap) throw new Error("This checkout was interrupted before its deposit was ready");
  return { mnemonic: record.mnemonic, swapId: record.swap.swapId, amountSat: record.amountSat, destination: record.payTo };
}

async function checkout(key: string): Promise<SatoraCheckoutRecord> {
  const existing = await getCheckout(key);
  if (!existing) throw new Error("This Satora payment is missing from this browser");
  return existing;
}

function paymentView(record: SatoraCheckoutRecord, live?: Observation, notice?: string): SatoraPayment {
  const { key, label, amountSat, payTo, verify, verifyBatch, swap } = record;
  const expiresAt = swap ? Math.min(swap.expiresAt, (record.verifyExpiresAt ?? Number.MAX_SAFE_INTEGER) * 1000) : undefined;
  const payment: SatoraPayment = {
    key, label, amountSat, payTo, verify, verifyBatch, expiresAt,
    depositAddress: swap?.depositAddress, sourceAmount: swap?.sourceAmount,
    status: notice ?? (swap ? "Checking saved Satora payment…" : "Checkout was interrupted before a deposit was issued"),
    canPay: false, canRecover: false,
  };
  if (!live || notice) return payment;

  const status = live.swap.status;
  const hasBalance = (live.balance ?? 0n) > 0n;
  if (PAID_OUT.has(status)) payment.status = "Arkade payout sent. Waiting for receiver confirmation…";
  else if (REFUNDED.has(status)) payment.status = "Refund available in your checkout account. Use the recovery file to access it.";
  else if (record.recovery) payment.status = record.recovery.txId ? "Recovery transaction submitted" : "Recovery transaction status is unconfirmed";
  else if (status === "pending") {
    if (record.funding || live.swap.fundingTxId) {
      payment.status = record.funding?.txId || live.swap.fundingTxId
        ? "USDC funding submitted. Waiting for confirmation…"
        : "Funding status is unconfirmed. Keep the recovery file and check again later.";
    } else if (expiresAt !== undefined && Date.now() >= expiresAt) {
      payment.status = hasBalance ? "USDC remains in the deposit account. Check again when the swap expires to recover it." : "Deposit window closed";
    } else if (hasBalance) {
      payment.status = "The USDC balance differs from the quote. Recover it after the swap expires.";
    } else {
      payment.status = "Awaiting USDC deposit on Polygon";
      payment.canPay = live.balance === 0n;
    }
  } else if (status === "expired") {
    payment.status = hasBalance ? "Satora swap expired with USDC in the deposit account" : "Satora swap expired";
    if (hasBalance && !record.funding && !live.swap.fundingTxId) {
      payment.canRecover = true;
      payment.recoveryKind = "deposit";
      payment.recoveryNeedsGas = true;
    } else if (hasBalance) {
      payment.status = "USDC remains in the deposit account. Check the Polygon funding status before recovering with your deposit key.";
    }
  } else if (REFUNDABLE.has(status) && !record.claim?.txId && !live.swap.claimTxId) {
    payment.status = "Satora reported a refundable swap";
    payment.canRecover = true;
    payment.recoveryKind = "contract";
  } else if (status === "serverfunded" || status === "clientredeeming" || record.claim?.txId) {
    payment.status = "Completing the Arkade payout…";
  } else {
    payment.status = "Confirming the swap with Satora…";
  }
  return payment;
}

async function observe(record: SatoraCheckoutRecord, sdk: typeof import("./satora-sdk.js")): Promise<Observation> {
  const swap = await sdk.readSatoraSwap(intentFor(record));
  if (swap.swapId !== record.swap?.swapId || swap.depositAddress !== record.swap.depositAddress || swap.sourceAmount !== record.swap.sourceAmount) {
    throw new Error("Satora returned different deposit details for this saved payment");
  }
  const balance = swap.status === "pending" || swap.status === "expired" ? await sdk.readSatoraDeposit(swap.depositAddress) : undefined;
  return { swap, balance };
}

export async function quoteSatoraPayment(amountSat: number): Promise<{ sourceAmount: string }> {
  browserLocks();
  return (await import("./satora-sdk.js")).quoteSatoraSwap(amountSat);
}

export async function startSatoraPayment(answer: InvoiceResult, amountSat: number, maxSourceAmount: string, label?: string): Promise<SatoraPayment> {
  const target = satoraPaymentTarget(answer, amountSat);
  if (target.expiresAt !== undefined && Date.now() >= target.expiresAt * 1000) throw new Error("Request a new LNURL payment before funding");
  if (!/^[1-9]\d{0,77}$/.test(maxSourceAmount)) throw new Error("Request a valid Satora quote before funding");
  return browserLocks().request(`lnurl-satora:${target.verify}`, async () => {
    const existing = await getCheckout(target.verify);
    if (existing) return paymentView(existing);
    const record: SatoraCheckoutRecord = {
      key: target.verify, label, amountSat, payTo: target.destination, verify: target.verify, verifyBatch: target.verifyBatch,
      verifyExpiresAt: target.expiresAt, mnemonic: generateMnemonic(wordlist, 256), createdAt: Date.now(),
    };
    await saveCheckout(record);
    const sdk = await import("./satora-sdk.js");
    record.swap = await sdk.createSatoraSwap({ mnemonic: record.mnemonic, amountSat, destination: record.payTo, maxSourceAmount });
    await saveCheckout(record);
    return paymentView(record);
  });
}

export async function listSatoraPayments(): Promise<SatoraPayment[]> {
  if (typeof indexedDB === "undefined") return [];
  return (await listCheckouts()).filter((record) => record.swap !== undefined).map((record) => paymentView(record));
}

export async function syncSatoraPayment(key: string): Promise<SatoraPayment> {
  return browserLocks().request(`lnurl-satora:${key}`, async () => {
    const record = await checkout(key);
    if (!record.swap) return paymentView(record);
    const sdk = await import("./satora-sdk.js");
    let live: Observation;
    try {
      live = await observe(record, sdk);
    } catch {
      return paymentView(record, undefined, "Could not verify the deposit and swap. Checking again…");
    }
    const { swap, balance } = live;
    const intent = intentFor(record);
    const withinVerifyWindow = record.verifyExpiresAt === undefined || Date.now() < record.verifyExpiresAt * 1000;
    if (!record.recovery && !record.funding && !swap.fundingTxId && withinVerifyWindow && swap.status === "pending" && balance === BigInt(swap.sourceAmount)) {
      try {
        const txId = await sdk.fundSatoraSwap(intent, async () => {
          // A stale pending response cannot authorize a second relay after a lost response.
          record.funding = {};
          await saveCheckout(record);
        });
        record.funding = { txId };
        await saveCheckout(record);
      } catch {
        return record.funding ? paymentView(record, live) : paymentView(record, live, "Funding eligibility changed. Checking again…");
      }
    }
    const resumingClaim = swap.status === "clientredeeming" && record.claim !== undefined;
    const canClaim = resumingClaim || (swap.status === "serverfunded" && !swap.claimTxId && !record.claim?.txId);
    if (!record.recovery && canClaim &&
      (record.claim === undefined || Date.now() - record.claim.startedAt >= CLAIM_RETRY_MS)) {
      const beforeClaim = async () => {
        // Only an amount-checked claim may later resume and publish its saved preimage.
        record.claim = { ...record.claim, startedAt: Date.now() };
        await saveCheckout(record);
      };
      try {
        if (resumingClaim) await beforeClaim();
        const txId = await sdk.claimSatoraSwap(intent, beforeClaim);
        record.claim = { startedAt: record.claim?.startedAt ?? Date.now(), txId };
        await saveCheckout(record);
      } catch {
        return paymentView(record, live, "Arkade claim is still pending. Checking again…");
      }
    }
    return paymentView(record, live);
  });
}

export async function recoverSatoraPayment(key: string, refundAddress?: string): Promise<string> {
  return browserLocks().request(`lnurl-satora:${key}`, async () => {
    const record = await checkout(key);
    const sdk = await import("./satora-sdk.js");
    const live = await observe(record, sdk);
    const { recoveryKind } = paymentView(record, live);
    if (!recoveryKind) throw new Error("Satora has not reported a balance or lock eligible for recovery");
    const beforeSubmit = async () => {
      record.recovery = { source: recoveryKind };
      await saveCheckout(record);
    };
    const intent = intentFor(record);
    const txId = recoveryKind === "deposit"
      ? await sdk.recoverSatoraDeposit(intent, refundAddress ?? "", beforeSubmit)
      : await sdk.refundSatoraSwap(intent, beforeSubmit);
    record.recovery = { source: recoveryKind, txId };
    await saveCheckout(record);
    return txId;
  });
}

export async function exportSatoraPaymentRecovery(key: string) {
  const record = await checkout(key);
  const intent = intentFor(record);
  const depositPrivateKey = await (await import("./satora-sdk.js")).exportSatoraRecoveryKey(intent);
  return { swapId: intent.swapId, depositAddress: record.swap!.depositAddress, depositPrivateKey, mnemonic: record.mnemonic };
}
