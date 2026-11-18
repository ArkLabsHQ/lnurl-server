import { createHmac, randomUUID } from "node:crypto";
import type { StoredSwap, SwapStatus, SwapStorage } from "@satora/swap";
import { decryptToken, encryptToken } from "../crypto.js";
import type { Db } from "../db/connection.js";
import { SATORA_PAYMENT_OPTION, SatoraCapacityError } from "../rails/satora.js";
import type { SatoraSwapSnapshot } from "../rails/satora-sdk.js";

export type RecoveryKind = "deposit" | "htlc-refund" | "refunded-asset";
export type RecoveryState = "submitting" | "submitted" | "confirmed";

interface Reservation {
  id: string;
  verify_id: string;
  address_id: number;
  amount_sat: number;
  mnemonic: Uint8Array;
}

export interface SatoraOrder extends Reservation {
  destination: string;
  covenant_script: string;
  swap_id: string;
  deposit_address: string;
  source_amount: string;
  provider_status: SwapStatus;
  observed_balance: string | null;
  expires_at: number;
  active: number;
  next_poll_at: number;
  fund_started: number;
  funding_tx_id: string | null;
  claim_started: number;
  claim_candidate_tx_id: string | null;
  claim_tx_id: string | null;
  refund_tx_id: string | null;
  refund_withdrawn: number;
  recovery_kind: RecoveryKind | null;
  recovery_attempt: string | null;
  recovery_address: string | null;
  recovery_tx_id: string | null;
  recovery_state: RecoveryState | null;
  created_at: number;
}

const ORDER_COLUMNS = "id, verify_id, address_id, amount_sat, mnemonic, destination, covenant_script, swap_id, " +
  "deposit_address, source_amount, provider_status, observed_balance, expires_at, active, next_poll_at, " +
  "fund_started, funding_tx_id, claim_started, claim_candidate_tx_id, claim_tx_id, refund_tx_id, refund_withdrawn, recovery_kind, recovery_address, " +
  "recovery_attempt, recovery_tx_id, recovery_state, created_at";

export function hasSatoraOrders(db: Db): boolean {
  return !!db.prepare("SELECT 1 FROM satora_orders WHERE deposit_address IS NOT NULL LIMIT 1").get();
}

export function findSatoraFundingReference(db: Db, verifyId: string): string | undefined {
  const row = db.prepare("SELECT funding_tx_id FROM satora_orders WHERE verify_id = ? AND active = 1").get(verifyId) as
    { funding_tx_id: string | null } | undefined;
  return row?.funding_tx_id && /^0x[0-9a-f]{64}$/i.test(row.funding_tx_id) ? row.funding_tx_id.toLowerCase() : undefined;
}

export function hasPendingSatoraOrders(db: Db, now = Date.now()): boolean {
  return !!db.prepare(`
    SELECT 1 FROM satora_orders o JOIN settlements s ON s.payment_hash = o.verify_id
    WHERE o.active = 1 AND s.payout_reference IS NULL AND (
      o.expires_at > ? OR o.claim_tx_id IS NOT NULL OR (
        o.fund_started = 1 AND o.provider_status NOT IN (
          'clientrefunded', 'clientrefundedserverfunded', 'clientrefundedserverrefunded', 'clientredeemedandclientrefunded'
        )
      )
    ) LIMIT 1
  `).get(now);
}

function seal(value: string, key: Buffer): Uint8Array {
  const { ciphertext, iv, tag } = encryptToken(value, key);
  return Buffer.concat([iv, tag, ciphertext]);
}

function unseal(value: Uint8Array, key: Buffer): string {
  return decryptToken({
    iv: Buffer.from(value.subarray(0, 12)),
    tag: Buffer.from(value.subarray(12, 28)),
    ciphertext: Buffer.from(value.subarray(28)),
  }, key);
}

export class SatoraOrderStore {
  constructor(private db: Db, private key: Buffer) {
    if (key.length !== 32) throw new Error("Satora requires a 32-byte encryption key");
    const existing = db.prepare("SELECT id, verify_id, address_id, amount_sat, mnemonic FROM satora_orders WHERE deposit_address IS NOT NULL LIMIT 1")
      .get() as unknown as Reservation | undefined;
    if (existing) this.openMnemonic(existing);
  }

  private keyFor(order: Reservation, scope: string): Buffer {
    return createHmac("sha256", this.key)
      .update(JSON.stringify(["satora", scope, order.id, order.verify_id, order.address_id, order.amount_sat]))
      .digest();
  }

  openMnemonic(order: Reservation): string {
    return unseal(order.mnemonic, this.keyFor(order, "mnemonic"));
  }

  reserve(addressId: number, amountSat: number, verifyId: string, mnemonic: string, at: number, until: number): Reservation {
    const order: Reservation = { id: randomUUID(), verify_id: verifyId, address_id: addressId, amount_sat: amountSat, mnemonic: Buffer.alloc(0) };
    order.mnemonic = seal(mnemonic, this.keyFor(order, "mnemonic"));
    const result = this.db.prepare(`
      INSERT INTO satora_orders(id, verify_id, address_id, amount_sat, mnemonic, created_at, expires_at, next_poll_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM (
        SELECT COUNT(*) AS total, COUNT(CASE WHEN address_id = ? THEN 1 END) AS for_address
        FROM satora_orders WHERE fund_started = 0 AND expires_at > ?
      ) WHERE total < 20 AND for_address < 5
    `).run(order.id, verifyId, addressId, amountSat, order.mnemonic, at, until, at, addressId, at);
    if (result.changes !== 1) throw new SatoraCapacityError();
    return order;
  }

  saveDestination(id: string, destination: string, script: string): void {
    this.db.prepare("UPDATE satora_orders SET destination = ?, covenant_script = ? WHERE id = ?").run(destination, script, id);
  }

  saveQuote(id: string, snapshot: SatoraSwapSnapshot, at: number): void {
    const result = this.db.prepare(`
      UPDATE satora_orders SET deposit_address = ?, source_amount = ?, provider_status = ?, expires_at = ?, next_poll_at = ?
      WHERE id = ? AND swap_id = ? AND sdk_state IS NOT NULL AND destination IS NOT NULL AND covenant_script IS NOT NULL
        AND expires_at > ? AND deposit_address IS NULL
    `).run(snapshot.depositAddress, snapshot.sourceAmount, snapshot.status, snapshot.expiresAt, at, id, snapshot.swapId, at);
    if (result.changes !== 1) throw new Error("Satora order could not be saved");
  }

  abandon(id: string, at: number): void {
    // Retain any SDK recovery material that was saved before a provider error.
    this.db.prepare("DELETE FROM satora_orders WHERE id = ? AND swap_id IS NULL AND active = 0").run(id);
    this.db.prepare("UPDATE satora_orders SET expires_at = ? WHERE id = ? AND active = 0 AND deposit_address IS NULL").run(at, id);
  }

  activate(swapId: string, at: number): boolean {
    return this.db.prepare(`
      UPDATE satora_orders AS o SET active = 1, next_poll_at = ?
      WHERE o.swap_id = ? AND o.active = 0 AND o.expires_at > ? AND EXISTS (
        SELECT 1 FROM settlements s WHERE s.payment_hash = o.verify_id AND s.address_id = o.address_id
        AND s.payment_option = ? AND s.covenant_script = o.covenant_script
        AND s.payment_destination = o.deposit_address COLLATE NOCASE AND s.amount_msat = o.amount_sat * 1000
      )
    `).run(at, swapId, at, SATORA_PAYMENT_OPTION).changes === 1;
  }

  storage(order: Reservation): SwapStorage {
    const key = this.keyFor(order, "sdk");
    const read = this.db.prepare("SELECT sdk_state FROM satora_orders WHERE id = ? AND swap_id = ?");
    const write = this.db.prepare(`
      UPDATE satora_orders SET sdk_state = ?, swap_id = ? WHERE id = ? AND (swap_id IS NULL OR swap_id = ?)
    `);
    const get = async (swapId: string): Promise<StoredSwap | null> => {
      const row = read.get(order.id, swapId) as { sdk_state: Uint8Array } | undefined;
      return row ? JSON.parse(unseal(row.sdk_state, key)) as StoredSwap : null;
    };
    const store = async (swap: StoredSwap): Promise<void> => {
      const encrypted = seal(JSON.stringify(swap), key);
      if (write.run(encrypted, swap.swapId, order.id, swap.swapId).changes !== 1) throw new Error("Satora SDK order mismatch");
    };
    const list = async (): Promise<string[]> => {
      const row = this.db.prepare("SELECT swap_id FROM satora_orders WHERE id = ? AND swap_id IS NOT NULL")
        .get(order.id) as { swap_id: string } | undefined;
      return row ? [row.swap_id] : [];
    };
    const preserve = async (): Promise<void> => { throw new Error("Satora order recovery material must be retained"); };
    return {
      get, store, list, delete: preserve, clear: preserve,
      getAll: async () => (await Promise.all((await list()).map(get))).filter((swap): swap is StoredSwap => swap !== null),
      update: async (swapId, response) => {
        const stored = await get(swapId);
        if (!stored) throw new Error("Satora SDK order cannot be found");
        await store({ ...stored, response, updatedAt: Date.now() });
      },
    };
  }

  find(ref: string): SatoraOrder | undefined {
    return this.db.prepare(`SELECT ${ORDER_COLUMNS} FROM satora_orders WHERE deposit_address IS NOT NULL AND (swap_id = ? OR verify_id = ?) LIMIT 1`)
      .get(ref, ref) as unknown as SatoraOrder | undefined;
  }

  list(): SatoraOrder[] {
    return this.db.prepare(`SELECT ${ORDER_COLUMNS} FROM satora_orders WHERE deposit_address IS NOT NULL ORDER BY created_at DESC LIMIT 100`)
      .all() as unknown as SatoraOrder[];
  }

  due(at: number): SatoraOrder[] {
    const priority = "(expires_at > ? OR (fund_started = 1 AND claim_tx_id IS NULL AND expires_at > ?))";
    const select = `SELECT ${ORDER_COLUMNS} FROM satora_orders WHERE active = 1 AND next_poll_at <= ?`;
    const order = "ORDER BY next_poll_at, id";
    const recent = at - 25 * 60 * 60_000;
    const fresh = this.db.prepare(`${select} AND ${priority} ${order} LIMIT 16`).all(at, at, recent);
    const late = this.db.prepare(`${select} AND NOT ${priority} ${order} LIMIT 4`).all(at, at, recent);
    return [...fresh, ...late] as unknown as SatoraOrder[];
  }

  schedule(id: string, previous: number, next: number): boolean {
    return this.db.prepare("UPDATE satora_orders SET next_poll_at = ? WHERE id = ? AND next_poll_at = ?")
      .run(next, id, previous).changes === 1;
  }

  observe(id: string, snapshot: SatoraSwapSnapshot, balance: bigint | null): void {
    this.db.prepare(`
      UPDATE satora_orders SET provider_status = ?, observed_balance = COALESCE(?, observed_balance),
        funding_tx_id = COALESCE(funding_tx_id, ?),
        claim_tx_id = COALESCE(claim_tx_id, CASE WHEN claim_candidate_tx_id = ? THEN ? ELSE NULL END)
      WHERE id = ?
    `).run(snapshot.status, balance?.toString() ?? null, snapshot.fundingTxId ?? null,
      snapshot.claimTxId ?? null, snapshot.claimTxId ?? null, id);
  }

  observeBalance(id: string, balance: bigint): void {
    this.db.prepare("UPDATE satora_orders SET observed_balance = ? WHERE id = ?").run(balance.toString(), id);
  }

  beginFund(id: string, at: number): boolean {
    return this.db.prepare(`
      UPDATE satora_orders SET fund_started = 1 WHERE id = ? AND active = 1 AND expires_at > ?
        AND fund_started = 0 AND funding_tx_id IS NULL AND recovery_kind IS NULL
    `).run(id, at).changes === 1;
  }

  saveFunding(id: string, txId: string): void {
    this.db.prepare("UPDATE satora_orders SET fund_started = 1, funding_tx_id = ? WHERE id = ?")
      .run(txId, id);
  }

  beginClaim(id: string, txId: string): boolean {
    return this.db.prepare(`
      UPDATE satora_orders SET claim_started = 1, claim_candidate_tx_id = ? WHERE id = ? AND active = 1 AND claim_started = 0
        AND claim_tx_id IS NULL AND fund_started = 1 AND recovery_kind IS NULL
    `).run(txId, id).changes === 1;
  }

  saveClaim(id: string, txId: string): void {
    const saved = this.db.prepare("UPDATE satora_orders SET claim_tx_id = ? WHERE id = ? AND claim_candidate_tx_id = ?")
      .run(txId, id, txId);
    if (saved.changes !== 1) throw new Error("Satora claim returned a different transaction");
  }

  beginRecovery(order: SatoraOrder, attempt: string, kind: RecoveryKind, refundAddress: string, txId: string | undefined, requireUnfunded: boolean, at: number): boolean {
    return this.db.prepare(`
      UPDATE satora_orders SET recovery_kind = ?, recovery_attempt = ?, recovery_address = ?, recovery_tx_id = ?, recovery_state = 'submitting'
      WHERE id = ? AND active = 1 AND recovery_attempt IS ? AND recovery_state IS ?
        AND (recovery_address IS NULL OR recovery_address = ?)
        AND (? = 0 OR (expires_at <= ? AND fund_started = 0 AND funding_tx_id IS NULL))
        AND (? <> 'htlc-refund' OR (claim_started = 0 AND claim_tx_id IS NULL))
        AND (? <> 'refunded-asset' OR refund_withdrawn = 0)
    `).run(kind, attempt, refundAddress, txId ?? null, order.id, order.recovery_attempt,
      order.recovery_state, refundAddress, +requireUnfunded, at, kind, kind).changes === 1;
  }

  saveRecoverySubmission(id: string, attempt: string, txId: string): void {
    this.db.prepare(`
      UPDATE satora_orders SET recovery_tx_id = ?, recovery_state = 'submitted'
      WHERE id = ? AND recovery_attempt = ? AND recovery_state IN ('submitting', 'submitted')
        AND (recovery_tx_id IS NULL OR recovery_tx_id = ?)
    `).run(txId, id, attempt, txId);
  }

  finishRecovery(order: SatoraOrder, txId: string, receipt: "success" | "reverted"): boolean {
    const success = receipt === "success";
    return this.db.prepare(`
      UPDATE satora_orders SET recovery_kind = ?, recovery_state = ?, recovery_tx_id = ?,
        refund_tx_id = COALESCE(refund_tx_id, ?), refund_withdrawn = MAX(refund_withdrawn, ?)
      WHERE id = ? AND recovery_attempt = ? AND recovery_state = ? AND recovery_tx_id IS ?
    `).run(success ? order.recovery_kind : null, success ? "confirmed" : null, success ? txId : null,
      success && order.recovery_kind === "htlc-refund" ? txId : null,
      +(success && order.recovery_kind === "refunded-asset"),
      order.id, order.recovery_attempt, order.recovery_state, order.recovery_tx_id).changes === 1;
  }
}
