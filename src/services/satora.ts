import { randomUUID } from "node:crypto";
import type { SwapStatus } from "@satora/swap";
import { getAddress, isAddress, zeroAddress } from "viem";
import type { Db } from "../db/connection.js";
import type { Logger } from "../logger.js";
import * as satoraSdk from "../rails/satora-sdk.js";
import type { SatoraIntent, SatoraSwapSnapshot } from "../rails/satora-sdk.js";
import type { SatoraCheckout } from "../rails/satora.js";
import { startCatchUpLoop, type CatchUpLoop } from "../workers/catch-up-loop.js";
import { SatoraOrderStore, type RecoveryKind, type SatoraOrder } from "./satora-store.js";

const POLL_MS = 10_000;
const POLL_LEASE_MS = 120_000;
const EXPIRED_POLL_MS = 15 * 60_000;
const FUNDED_POLL_MS = 30_000;
const LATE_POLL_MS = 7 * 24 * 60 * 60_000;
const RESERVATION_MS = 60_000;
const QUOTE_WINDOW_MS = 15 * 60_000;

const REFUNDABLE = new Set<SwapStatus>(["clientfundedserverrefunded", "clientinvalidfunded", "clientfundedtoolate", "serverwontfund"]);
const REFUNDED = new Set<SwapStatus>(["clientrefunded", "clientrefundedserverfunded", "clientrefundedserverrefunded"]);

type SatoraSdk = Pick<typeof satoraSdk,
  "generateSatoraMnemonic" | "createSatoraSwap" | "readSatoraSwap" | "readSatoraDeposit" | "fundSatoraSwap" |
  "claimSatoraSwap" | "continueSatoraClaim" | "readSatoraRecoveryReceipt" | "recoverSatoraDeposit" |
  "refundSatoraSwap" | "withdrawSatoraRefund" | "hasFinalizedSatoraRefund"
>;

export class SatoraRecoveryError extends Error {}

function orderDetails(order: SatoraOrder) {
  return {
    swapId: order.swap_id,
    verifyId: order.verify_id,
    addressId: order.address_id,
    amountSat: order.amount_sat,
    depositAddress: order.deposit_address,
    sourceAmount: order.source_amount,
    observedBalance: order.observed_balance,
    status: order.provider_status,
    expiresAt: order.expires_at,
    active: order.active === 1,
    fundingStarted: order.fund_started === 1,
    fundingTxId: order.funding_tx_id,
    claimStarted: order.claim_started === 1,
    claimCandidateTxId: order.claim_candidate_tx_id,
    claimTxId: order.claim_tx_id,
    refundTxId: order.refund_tx_id,
    recoveryKind: order.recovery_kind,
    recoveryAddress: order.recovery_address,
    recoveryTxId: order.recovery_tx_id,
    recoveryState: order.recovery_state,
  };
}

export class SatoraService implements SatoraCheckout {
  private store: SatoraOrderStore;
  private loop?: CatchUpLoop;
  private inFlight?: Promise<void>;

  constructor(
    db: Db,
    encryptionKey: Buffer,
    private logger: Logger,
    private sdk: SatoraSdk,
    private now: () => number,
  ) {
    this.store = new SatoraOrderStore(db, encryptionKey);
  }

  async create({ addressId, verifyId, amountSat, deriveRecipient }: Parameters<SatoraCheckout["create"]>[0]) {
    const at = this.now();
    const mnemonic = this.sdk.generateSatoraMnemonic();
    const order = this.store.reserve(addressId, amountSat, verifyId, mnemonic, at, at + RESERVATION_MS);
    try {
      const { address: destination, script: covenantScript } = await deriveRecipient();
      this.store.saveDestination(order.id, destination, covenantScript);
      const snapshot = await this.sdk.createSatoraSwap({ destination, amountSat, mnemonic, storage: this.store.storage(order) });
      const now = this.now();
      const expiresAt = Math.min(snapshot.expiresAt, now + QUOTE_WINDOW_MS);
      if (snapshot.status !== "pending" || expiresAt <= now || snapshot.fundingTxId || snapshot.claimTxId) {
        throw new Error("Satora payment is currently unavailable");
      }
      this.store.saveQuote(order.id, { ...snapshot, expiresAt }, now);
      return { swapId: snapshot.swapId, depositAddress: snapshot.depositAddress, sourceAmount: snapshot.sourceAmount, expiresAt, covenantScript };
    } catch {
      this.store.abandon(order.id, this.now());
      throw new Error("Satora payment is currently unavailable");
    }
  }

  activate(swapId: string): void {
    if (!this.store.activate(swapId, this.now())) throw new Error("Satora payment is currently unavailable");
  }

  start(): () => void {
    this.loop ??= startCatchUpLoop({
      pass: () => this.loop ? this.pollOnce() : Promise.resolve(),
      intervalMs: POLL_MS,
      immediate: true,
      onError: () => this.logger.warn("satora_order_poll_failed"),
    });
    return () => {
      this.loop?.stop();
      this.loop = undefined;
    };
  }

  async waitForIdle(): Promise<void> {
    await this.inFlight;
  }

  pollOnce(): Promise<void> {
    this.inFlight ??= this.pollDue().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async pollDue(): Promise<void> {
    const due = this.store.due(this.now());
    for (let start = 0; start < due.length; start += 4) {
      await Promise.all(due.slice(start, start + 4).map((order) => this.pollOrder(order)));
    }
  }

  private intent(order: SatoraOrder): SatoraIntent {
    return {
      amountSat: order.amount_sat, destination: order.destination, swapId: order.swap_id,
      mnemonic: this.store.openMnemonic(order), storage: this.store.storage(order),
    };
  }

  private async snapshot(order: SatoraOrder, intent: SatoraIntent): Promise<SatoraSwapSnapshot> {
    const snapshot = await this.sdk.readSatoraSwap(intent);
    if (snapshot.swapId !== order.swap_id || snapshot.depositAddress !== order.deposit_address || snapshot.sourceAmount !== order.source_amount) {
      throw new Error("Satora changed the saved quote");
    }
    return snapshot;
  }

  private async pollOrder(order: SatoraOrder): Promise<void> {
    const now = this.now();
    const leaseUntil = now + POLL_LEASE_MS;
    if (!this.store.schedule(order.id, order.next_poll_at, leaseUntil)) return;
    let cadence = POLL_MS;
    try {
      const open = now < order.expires_at;
      if (!open) cadence = order.fund_started && !order.claim_tx_id && now < order.expires_at + 60 * 60_000
        ? FUNDED_POLL_MS : EXPIRED_POLL_MS;
      if (!open && now > order.expires_at + LATE_POLL_MS && (!order.fund_started ||
          (order.claim_tx_id && order.funding_tx_id) || REFUNDED.has(order.provider_status))) {
        // Old addresses are always available through on-demand inspection and recovery.
        cadence = Number.MAX_SAFE_INTEGER - now;
      }

      let balance: bigint | null = null;
      if (!order.fund_started || order.claim_tx_id || order.recovery_kind || REFUNDED.has(order.provider_status)) {
        balance = await this.sdk.readSatoraDeposit(order.deposit_address).catch((error) => {
          if (!order.fund_started) throw error;
          return null;
        });
        if (balance !== null) this.store.observeBalance(order.id, balance);
        if (!order.fund_started && !(open && balance === BigInt(order.source_amount)) &&
            !(!open && balance && order.provider_status !== "expired") && !order.recovery_kind) {
          return;
        }
      }

      const intent = this.intent(order);
      const snapshot = await this.snapshot(order, intent);
      this.store.observe(order.id, snapshot, balance);
      if (order.recovery_kind) {
        await this.reconcileRecovery(order, snapshot);
        return;
      }
      if (open && !order.fund_started && balance === BigInt(order.source_amount) && !snapshot.fundingTxId && snapshot.status === "pending") {
        const txId = await this.sdk.fundSatoraSwap(intent, async () => {
          if (!this.store.beginFund(order.id, this.now())) throw new Error("Satora funding is already reserved or closed");
        });
        this.store.saveFunding(order.id, txId);
        return;
      }
      if (!order.fund_started || order.claim_tx_id || (snapshot.claimTxId && snapshot.claimTxId === order.claim_candidate_tx_id)) return;

      if (snapshot.status === "serverfunded" || snapshot.status === "clientredeeming") cadence = POLL_MS;
      if (order.claim_candidate_tx_id && (snapshot.status === "clientredeeming" || snapshot.status === "serverfunded")) {
        const txId = await this.sdk.continueSatoraClaim(intent, order.claim_candidate_tx_id);
        this.store.saveClaim(order.id, txId);
      } else if (!order.claim_started && snapshot.status === "serverfunded") {
        const txId = await this.sdk.claimSatoraSwap(intent, async (candidateTxId) => {
          if (!candidateTxId || !/^[0-9a-f]{64}$/.test(candidateTxId) || !this.store.beginClaim(order.id, candidateTxId)) {
            throw new Error("Satora claim could not be reserved");
          }
        });
        this.store.saveClaim(order.id, txId);
      }
    } catch {
      this.logger.warn("satora_order_poll_failed", { swapId: order.swap_id });
    } finally {
      this.store.schedule(order.id, leaseUntil, this.now() + cadence);
    }
  }

  listRecoveryOrders(verifyId?: string) {
    if (verifyId !== undefined) {
      const order = this.store.find(verifyId);
      return order ? [orderDetails(order)] : [];
    }
    return this.store.list().map(orderDetails);
  }

  async inspect(ref: string) {
    const order = this.store.find(ref);
    if (!order) throw new SatoraRecoveryError("Satora order was not found");
    const intent = this.intent(order);
    try {
      const [snapshot, balance] = await Promise.all([this.snapshot(order, intent), this.sdk.readSatoraDeposit(order.deposit_address)]);
      this.store.observe(order.id, snapshot, balance);
      await this.reconcileRecovery(order, snapshot);
    } catch {
      throw new SatoraRecoveryError("Could not refresh this Satora order. Use the local list to see the last observation");
    }
    return orderDetails(this.store.find(order.swap_id)!);
  }

  private async reconcileRecovery(order: SatoraOrder, snapshot: SatoraSwapSnapshot) {
    if (!order.recovery_state || order.recovery_state === "confirmed") return;
    const txId = order.recovery_tx_id ?? (order.recovery_kind === "htlc-refund" ? snapshot.refundTxId : undefined);
    if (!txId) return;
    const receipt = order.recovery_kind === "htlc-refund" && !order.recovery_tx_id
      ? (await this.sdk.hasFinalizedSatoraRefund(this.intent(order), txId) ? "success" : null)
      : await this.sdk.readSatoraRecoveryReceipt(txId);
    if (receipt) this.store.finishRecovery(order, txId, receipt);
  }

  async recover(ref: string, addressId: number, refundAddress: string) {
    const order = this.store.find(ref);
    if (!order || order.address_id !== addressId || !order.active) throw new SatoraRecoveryError("Active Satora order was not found for this address");
    if (!isAddress(refundAddress)) throw new SatoraRecoveryError("Use a valid Polygon recovery address");
    const recipient = getAddress(refundAddress);
    if (recipient === zeroAddress || recipient === order.deposit_address) throw new SatoraRecoveryError("Use a separate Polygon recovery address");
    if (order.recovery_address && recipient !== order.recovery_address) throw new SatoraRecoveryError("The recovery address is already bound to this order");
    try {
      return await this.recoverOrder(order, recipient);
    } catch (error) {
      if (error instanceof SatoraRecoveryError) throw error;
      if (error instanceof satoraSdk.SatoraRecoveryGasError) throw new SatoraRecoveryError(error.message);
      throw new SatoraRecoveryError("Could not complete the recovery step. Inspect the order before retrying");
    }
  }

  private async recoverOrder(order: SatoraOrder, recipient: string) {
    const intent = this.intent(order);
    const snapshot = await this.snapshot(order, intent);
    this.store.observe(order.id, snapshot, null);
    await this.reconcileRecovery(order, snapshot);
    const current = this.store.find(order.swap_id)!;
    if (current.recovery_state === "submitting" || current.recovery_state === "submitted") {
      return { kind: current.recovery_kind, txId: current.recovery_tx_id, state: current.recovery_state };
    }

    const attempt = randomUUID();
    const submit = (kind: RecoveryKind, requireUnfunded = false) => async (txId?: string) => {
      if (!this.store.beginRecovery(current, attempt, kind, recipient, txId, requireUnfunded, this.now())) {
        throw new SatoraRecoveryError("The Satora order changed during recovery preparation");
      }
    };
    const record = (kind: RecoveryKind, txId: string) => {
      this.store.saveRecoverySubmission(current.id, attempt, txId);
      return { kind, txId, state: "submitted" } as const;
    };

    if (current.refund_tx_id && !current.refund_withdrawn) {
      return record("refunded-asset", await this.sdk.withdrawSatoraRefund(intent, current.refund_tx_id, recipient, submit("refunded-asset")));
    }
    if (!current.refund_tx_id && REFUNDABLE.has(snapshot.status) && !current.claim_started && !current.claim_tx_id) {
      return record("htlc-refund", await this.sdk.refundSatoraSwap(intent, submit("htlc-refund")));
    }
    if (!current.refund_tx_id && !current.refund_withdrawn && snapshot.refundTxId && REFUNDED.has(snapshot.status)) {
      return record("refunded-asset", await this.sdk.withdrawSatoraRefund(intent, snapshot.refundTxId, recipient, submit("refunded-asset")));
    }
    const expiredUnfunded = snapshot.status === "expired" && !current.fund_started && !current.funding_tx_id;
    if (expiredUnfunded || (snapshot.status === "serverredeemed" && current.claim_tx_id) || REFUNDED.has(snapshot.status)) {
      const balance = await this.sdk.readSatoraDeposit(order.deposit_address);
      this.store.observeBalance(order.id, balance);
      if (balance > 0n) return record("deposit", await this.sdk.recoverSatoraDeposit(intent, recipient, submit("deposit", expiredUnfunded)));
      if (current.recovery_state !== "confirmed") throw new SatoraRecoveryError("There is no finalized Polygon USDC balance to recover");
    }
    if (current.recovery_state === "confirmed") return { kind: current.recovery_kind, txId: current.recovery_tx_id, state: current.recovery_state };
    throw new SatoraRecoveryError("This order is not eligible for automatic recovery. Inspect its funding and claim status");
  }
}

export function createSatoraService(deps: { db: Db; encryptionKey: Buffer; logger: Logger; sdk?: SatoraSdk; now?: () => number }): SatoraService {
  return new SatoraService(deps.db, deps.encryptionKey, deps.logger, deps.sdk ?? satoraSdk, deps.now ?? Date.now);
}
