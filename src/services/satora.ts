import { randomUUID } from "node:crypto";
import type { SwapStatus } from "@satora/swap";
import { getAddress, isAddress, zeroAddress } from "viem";
import type { Db } from "../db/connection.js";
import type { Logger } from "../logger.js";
import { isValidAddress } from "../rails/fixedfloat/catalogue.js";
import { hasSatoraEvmRpc } from "../rails/satora-evm.js";
import * as satoraSdk from "../rails/satora-sdk.js";
import type { SatoraEnsureGas, SatoraIntent, SatoraSwapSnapshot } from "../rails/satora-sdk.js";
import type { SolanaFeeSponsor } from "../rails/satora-solana.js";
import { satoraSource, type SatoraSource } from "../rails/satora-catalogue.js";
import type { SatoraCheckout } from "../rails/satora.js";
import { startCatchUpLoop, type CatchUpLoop } from "../workers/catch-up-loop.js";
import { SatoraOrderStore, type RecoveryKind, type SatoraOrder } from "./satora-store.js";

const POLL_MS = 10_000;
const POLL_LEASE_MS = 120_000;
const EXPIRED_POLL_MS = 15 * 60_000;
const FUNDED_POLL_MS = 30_000;
const LATE_POLL_MS = 7 * 24 * 60 * 60_000;
const RESERVATION_MS = 60_000;
const MAX_FUNDING_WINDOW_MS = 30 * 60_000;
const CCTP_POLL_TIMEOUT_MS = 60_000;
const BRIDGE_RECOVERY_LEASE_MS = 5 * 60_000;

const REFUNDABLE = new Set<SwapStatus>(["clientfundedserverrefunded", "clientinvalidfunded", "clientfundedtoolate", "serverwontfund"]);
const REFUNDED = new Set<SwapStatus>(["clientrefunded", "clientrefundedserverfunded", "clientrefundedserverrefunded"]);

type SatoraSdk = Pick<typeof satoraSdk,
  "generateSatoraMnemonic" | "createSatoraSwap" | "readSatoraSwap" | "readSatoraDeposit" | "fundSatoraSwap" |
  "claimSatoraSwap" | "continueSatoraClaim" | "readSatoraRecoveryReceipt" | "recoverSatoraDeposit" |
  "refundSatoraSwap" | "withdrawSatoraRefund" | "hasFinalizedSatoraRefund" |
  "resumeSatoraFunding" | "recoverSatoraBridgedDeposit" | "canRecoverUnburnedSatoraFunding" | "hasFinalizedSatoraBridgeRecovery"
>;

export class SatoraRecoveryError extends Error {}

function orderSource(optionId: string): SatoraSource {
  const source = satoraSource(optionId);
  if (!source) throw new Error("Satora payment source is unsupported");
  return source;
}

function orderDetails(order: SatoraOrder) {
  const source = satoraSource(order.payment_option);
  return {
    swapId: order.swap_id,
    verifyId: order.verify_id,
    addressId: order.address_id,
    paymentOption: order.payment_option,
    asset: source?.asset,
    amountSat: order.amount_sat,
    depositAddress: order.deposit_address,
    sourceAmount: order.source_amount,
    observedBalance: order.observed_balance,
    status: order.provider_status,
    expiresAt: order.expires_at,
    fundingExpiresAt: order.funding_expires_at ?? order.expires_at,
    active: order.active === 1,
    fundingStarted: order.fund_started === 1,
    fundingTxId: order.funding_tx_id,
    claimStarted: order.claim_started === 1,
    claimCandidateTxId: order.claim_candidate_tx_id,
    claimTxId: order.claim_tx_id,
    refundTxId: order.refund_tx_id,
    recoveryKind: order.recovery_kind,
    recoveryAddress: order.recovery_address,
    bridgeRecoveryAddress: order.bridge_recovery_address,
    recoveryTxId: order.recovery_tx_id,
    recoveryState: order.recovery_state,
    recoveryLeaseUntil: order.recovery_lease_until,
  };
}

function recoveryStatus(order: SatoraOrder) {
  return { kind: order.recovery_kind, txId: order.recovery_tx_id, state: order.recovery_state };
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
    private ensureGas?: SatoraEnsureGas,
    private checkGas?: (source: SatoraSource) => Promise<void>,
    private solanaSponsor?: SolanaFeeSponsor,
  ) {
    this.store = new SatoraOrderStore(db, encryptionKey);
  }

  isAvailable(optionId: string): boolean {
    const source = satoraSource(optionId);
    if (!source) return false;
    if (source.type === "solana") return this.solanaSponsor !== undefined;
    return hasSatoraEvmRpc(source.chain) && (source.gas !== "native" || this.ensureGas !== undefined);
  }

  async create({ addressId, verifyId, amountSat, optionId, deriveRecipient }: Parameters<SatoraCheckout["create"]>[0]) {
    if (!this.isAvailable(optionId)) throw new Error("Satora payment is currently unavailable");
    const source = orderSource(optionId);
    const at = this.now();
    const mnemonic = this.sdk.generateSatoraMnemonic();
    const order = this.store.reserve(addressId, amountSat, verifyId, optionId, mnemonic, at, at + RESERVATION_MS);
    try {
      if (source.type === "solana") await this.solanaSponsor?.checkGas();
      else if (source.gas === "native") await this.checkGas?.(source);
      const { address: destination, script: covenantScript } = await deriveRecipient();
      this.store.saveDestination(order.id, destination, covenantScript);
      const snapshot = await this.sdk.createSatoraSwap({
        destination, amountSat, source, mnemonic, storage: this.store.storage(order),
        ensureGas: this.ensureGas, solanaSponsor: this.solanaSponsor,
      });
      const now = this.now();
      const { expiresAt } = snapshot;
      if (snapshot.status !== "pending" || expiresAt <= now || snapshot.fundingTxId || snapshot.claimTxId) {
        throw new Error("Satora payment is currently unavailable");
      }
      const fundingExpiresAt = Math.min(snapshot.fundingExpiresAt ?? expiresAt, at + MAX_FUNDING_WINDOW_MS);
      if (fundingExpiresAt < expiresAt) throw new Error("Satora funding window is shorter than the checkout window");
      this.store.saveQuote(order.id, { ...snapshot, fundingExpiresAt }, now);
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

  private intent(order: SatoraOrder, source = orderSource(order.payment_option), fundingSignal?: AbortSignal): SatoraIntent {
    return {
      amountSat: order.amount_sat, destination: order.destination, swapId: order.swap_id,
      source, mnemonic: this.store.openMnemonic(order), storage: this.store.storage(order), ensureGas: this.ensureGas,
      cctpBurn: this.store.openCctpBurn(order), fundingSignal, solanaSponsor: this.solanaSponsor,
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
    let stage = "deposit";
    try {
      const source = orderSource(order.payment_option);
      const open = now < (order.funding_expires_at ?? order.expires_at);
      if (!open) cadence = order.fund_started && !order.claim_tx_id && now < order.expires_at + 60 * 60_000
        ? FUNDED_POLL_MS : EXPIRED_POLL_MS;
      if (!open && now > order.expires_at + LATE_POLL_MS && (!order.fund_started ||
          (order.claim_tx_id && order.funding_tx_id) || REFUNDED.has(order.provider_status))) {
        // Old addresses are always available through on-demand inspection and recovery.
        cadence = Number.MAX_SAFE_INTEGER - now;
      }

      let balance: bigint | null = null;
      if (!order.fund_started || order.claim_tx_id || order.recovery_kind || REFUNDED.has(order.provider_status)) {
        balance = await this.sdk.readSatoraDeposit(order.deposit_address, source, this.solanaSponsor).catch((error) => {
          if (!order.fund_started) throw error;
          return null;
        });
        if (balance !== null) this.store.observeBalance(order.id, balance);
        if (!order.fund_started && !(open && balance === BigInt(order.source_amount)) &&
            !(!open && balance && order.provider_status !== "expired") && !order.recovery_kind) {
          return;
        }
      }

      stage = "status";
      const intent = this.intent(order, source, source.mode === "cctp" ? AbortSignal.timeout(CCTP_POLL_TIMEOUT_MS) : undefined);
      const snapshot = await this.snapshot(order, intent);
      this.store.observe(order.id, snapshot, balance);
      if (order.recovery_kind) {
        stage = "recovery";
        await this.reconcileRecovery(order, snapshot);
        return;
      }
      if (open && !order.fund_started && balance === BigInt(order.source_amount) && !snapshot.fundingTxId && snapshot.status === "pending") {
        stage = "funding";
        const txId = await this.sdk.fundSatoraSwap(intent, async (candidateTxId, cctpBurn) => {
          if ((source.mode === "cctp") !== Boolean(cctpBurn) ||
              (cctpBurn && candidateTxId && cctpBurn.hash !== candidateTxId) ||
              !this.store.beginFund(order, this.now(), cctpBurn)) {
            throw new Error("Satora funding is already reserved or closed");
          }
        });
        this.store.saveFunding(order.id, txId);
        return;
      }
      if (intent.cctpBurn && order.fund_started && snapshot.status === "pending") {
        stage = "bridge-funding";
        const txId = await this.sdk.resumeSatoraFunding(intent);
        if (txId) this.store.saveFunding(order.id, txId);
        return;
      }
      if (!order.fund_started || order.claim_tx_id || (snapshot.claimTxId && snapshot.claimTxId === order.claim_candidate_tx_id)) return;

      stage = "claim";
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
      this.logger.warn("satora_order_poll_failed", { swapId: order.swap_id, paymentOption: order.payment_option, stage });
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
    try {
      const intent = this.intent(order);
      const [snapshot, balance] = await Promise.all([
        this.snapshot(order, intent), this.sdk.readSatoraDeposit(order.deposit_address, intent.source, this.solanaSponsor),
      ]);
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
    const source = orderSource(order.payment_option);
    let receipt: "success" | "reverted" | null;
    if (order.recovery_kind === "bridged-asset" && order.bridge_recovery_address) {
      receipt = await this.sdk.hasFinalizedSatoraBridgeRecovery(this.intent(order), txId, order.bridge_recovery_address) ? "success" : null;
    } else if (order.recovery_kind === "htlc-refund" && !order.recovery_tx_id) {
      receipt = await this.sdk.hasFinalizedSatoraRefund(this.intent(order), txId) ? "success" : null;
    } else {
      receipt = await this.sdk.readSatoraRecoveryReceipt(txId, source, this.usesSettlementChain(source, order.recovery_kind), this.solanaSponsor);
    }
    if (receipt) this.store.finishRecovery(order, txId, receipt);
  }

  async recover(ref: string, addressId: number, refundAddress: string) {
    const order = this.store.find(ref);
    if (!order || order.address_id !== addressId || !order.active) throw new SatoraRecoveryError("Active Satora order was not found for this address");
    const source = orderSource(order.payment_option);
    if (!isAddress(refundAddress) && !(source.type === "solana" && isValidAddress("solana", refundAddress))) {
      throw new SatoraRecoveryError("Use a valid recovery address on the recovery chain");
    }
    try {
      return await this.recoverOrder(order, refundAddress);
    } catch (error) {
      if (error instanceof SatoraRecoveryError) throw error;
      if (error instanceof satoraSdk.SatoraRecoveryGasError) throw new SatoraRecoveryError(error.message);
      throw new SatoraRecoveryError("Could not complete the recovery step. Inspect the order before retrying");
    }
  }

  async reconcileBridgeRecovery(ref: string, txHash: string) {
    if (!/^0x[0-9a-f]{64}$/i.test(txHash)) throw new SatoraRecoveryError("Use a valid Arbitrum recovery transaction hash");
    const txId = txHash.toLowerCase();
    const order = this.store.find(ref);
    if (!order?.active || order.recovery_kind !== "bridged-asset" || !order.recovery_state || !order.bridge_recovery_address) {
      throw new SatoraRecoveryError("No bridged Satora recovery is recorded for this order");
    }
    if (order.recovery_tx_id && order.recovery_tx_id !== txId) {
      throw new SatoraRecoveryError("The recovery transaction is already bound to this order");
    }
    if (order.recovery_state === "confirmed") return orderDetails(order);
    if (!await this.sdk.hasFinalizedSatoraBridgeRecovery(this.intent(order), txId, order.bridge_recovery_address)) {
      throw new SatoraRecoveryError("The transaction does not prove an Arbitrum USDC transfer to the bound recovery address");
    }
    if (!this.store.finishRecovery(order, txId, "success")) {
      throw new SatoraRecoveryError("The Satora recovery changed during reconciliation. Inspect the updated order");
    }
    return orderDetails(this.store.find(order.swap_id)!);
  }

  private usesSettlementChain(source: SatoraSource, kind: RecoveryKind | null): boolean {
    return source.mode === "cctp" && kind !== null && kind !== "deposit";
  }

  private recoveryRecipient(order: SatoraOrder, source: SatoraSource, address: string, kind: RecoveryKind): string {
    const hub = this.usesSettlementChain(source, kind);
    const evm = hub || source.type === "eip155";
    if (!(evm ? isAddress(address) : isValidAddress(source.type, address))) {
      throw new SatoraRecoveryError(hub ? "Use a valid Arbitrum recovery address" : "Use a valid recovery address on the payment chain");
    }
    const recipient = evm ? getAddress(address) : address;
    const sameDepositAddress = evm
      ? recipient.toLowerCase() === order.deposit_address.toLowerCase()
      : recipient === order.deposit_address;
    if (recipient === zeroAddress || recipient === "11111111111111111111111111111111" || sameDepositAddress) {
      throw new SatoraRecoveryError("Use a separate recovery address on the recovery chain");
    }
    const bound = hub ? order.bridge_recovery_address : order.recovery_address;
    if (bound && recipient !== bound) throw new SatoraRecoveryError("The recovery address is already bound to this order");
    return recipient;
  }

  private async recoverOrder(order: SatoraOrder, refundAddress: string) {
    const intent = this.intent(order);
    const snapshot = await this.snapshot(order, intent);
    this.store.observe(order.id, snapshot, null);
    await this.reconcileRecovery(order, snapshot);
    const current = this.store.find(order.swap_id)!;
    const attempt = randomUUID();
    const recipient = (kind: RecoveryKind) => this.recoveryRecipient(current, intent.source, refundAddress, kind);
    const record = (kind: RecoveryKind, txId: string) => {
      this.store.saveRecoverySubmission(current.id, attempt, txId);
      return { kind, txId, state: "submitted" } as const;
    };
    if (current.recovery_state === "submitting" || current.recovery_state === "submitted") {
      if (current.recovery_kind) recipient(current.recovery_kind);
      if (current.recovery_kind === "bridged-asset" && current.recovery_state === "submitting" && !current.recovery_tx_id &&
          snapshot.status === "expired" && this.now() >= (current.recovery_lease_until ?? 0)) {
        try {
          const destination = recipient("bridged-asset");
          const txId = await this.sdk.recoverSatoraBridgedDeposit({ ...intent, retryBridgeRecovery: true }, destination, async () => {
            const now = this.now();
            if (!this.store.retryBridgeRecovery(current, attempt, destination, now, now + BRIDGE_RECOVERY_LEASE_MS)) {
              throw new SatoraRecoveryError("The Satora recovery is already being reconciled");
            }
          });
          return record("bridged-asset", txId);
        } catch {
          return recoveryStatus(this.store.find(current.swap_id)!);
        }
      }
      return recoveryStatus(current);
    }
    const submit = (kind: RecoveryKind, requireUnfunded = false) => async (txId?: string) => {
      const now = this.now();
      const leaseUntil = kind === "bridged-asset" ? now + BRIDGE_RECOVERY_LEASE_MS : null;
      if (!this.store.beginRecovery(current, attempt, kind, recipient(kind), txId, requireUnfunded,
        this.usesSettlementChain(intent.source, kind), now, leaseUntil)) {
        throw new SatoraRecoveryError("The Satora order changed during recovery preparation");
      }
    };

    if (current.refund_tx_id && !current.refund_withdrawn) {
      return record("refunded-asset", await this.sdk.withdrawSatoraRefund(intent, current.refund_tx_id, recipient("refunded-asset"), submit("refunded-asset")));
    }
    if (!current.refund_tx_id && REFUNDABLE.has(snapshot.status) && !current.claim_started && !current.claim_tx_id) {
      recipient("htlc-refund");
      return record("htlc-refund", await this.sdk.refundSatoraSwap(intent, submit("htlc-refund")));
    }
    if (!current.refund_tx_id && !current.refund_withdrawn && snapshot.refundTxId && REFUNDED.has(snapshot.status)) {
      return record("refunded-asset", await this.sdk.withdrawSatoraRefund(intent, snapshot.refundTxId, recipient("refunded-asset"), submit("refunded-asset")));
    }
    const expiredUnfunded = snapshot.status === "expired" && !current.fund_started && !current.funding_tx_id;
    const expiredBridge = snapshot.status === "expired" && Boolean(intent.cctpBurn) && !current.claim_started;
    const unburned = expiredBridge && await this.sdk.canRecoverUnburnedSatoraFunding(intent);
    if (expiredBridge && !unburned && current.recovery_state !== "confirmed") {
      return record("bridged-asset", await this.sdk.recoverSatoraBridgedDeposit(intent, recipient("bridged-asset"), submit("bridged-asset")));
    }
    if (expiredUnfunded || unburned || (snapshot.status === "serverredeemed" && current.claim_tx_id) || REFUNDED.has(snapshot.status)) {
      const balance = await this.sdk.readSatoraDeposit(order.deposit_address, intent.source, this.solanaSponsor);
      this.store.observeBalance(order.id, balance);
      if (balance > 0n) return record("deposit", await this.sdk.recoverSatoraDeposit(intent, recipient("deposit"), submit("deposit", expiredUnfunded)));
      if (current.recovery_state !== "confirmed") throw new SatoraRecoveryError(`There is no finalized ${intent.source.unit} balance to recover`);
    }
    if (current.recovery_state === "confirmed") {
      if (current.recovery_kind) recipient(current.recovery_kind);
      return recoveryStatus(current);
    }
    throw new SatoraRecoveryError("This order is not eligible for automatic recovery. Inspect its funding and claim status");
  }
}

export function createSatoraService(deps: {
  db: Db;
  encryptionKey: Buffer;
  logger: Logger;
  sdk?: SatoraSdk;
  now?: () => number;
  ensureGas?: SatoraEnsureGas;
  checkGas?: (source: SatoraSource) => Promise<void>;
  solanaSponsor?: SolanaFeeSponsor;
}): SatoraService {
  return new SatoraService(
    deps.db, deps.encryptionKey, deps.logger, deps.sdk ?? satoraSdk, deps.now ?? Date.now,
    deps.ensureGas, deps.checkGas, deps.solanaSponsor,
  );
}
