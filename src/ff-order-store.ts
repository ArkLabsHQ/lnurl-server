import type { Db } from "./db/connection.js";
import type { OfflineSwapRecoveryV1 } from "./services/offline-swaps.js";
import { insertOfflineSwap } from "./offline-swap-store.js";

/** A token-deposit receive as accepted: the corridor swap that pays the receiver, and
 *  the FixedFloat order that pays the corridor's invoice. */
export interface AcceptedFfOrder {
  paymentHash: string;
  pr: string;
  sessionId: string;
  preimage: string;
  amountMsat: number;
  addressId?: number;
  paymentOption: string;
  recovery: OfflineSwapRecoveryV1;
  order: {
    id: string;
    token: string;
    ffCode: string;
    asset: string;
    unit: string;
    depositAddress: string;
    depositTag?: string | null;
    /** Base units, as an integer string. */
    depositAmount: string;
    /** The corridor invoice's face value; the receiver gets it less the solver fee. */
    invoiceAmountSat: number;
    status: string;
    /** Unix seconds. */
    expiresAt: number;
  };
}

export interface StoredFfOrder {
  paymentHash: string;
  orderId: string;
  /** FixedFloat's bearer credential for the order: for `order` calls, never for display. */
  token: string;
  ffCode: string;
  asset: string;
  unit: string;
  depositAddress: string;
  depositTag: string | null;
  depositAmount: string;
  depositTxid: string | null;
  invoiceAmountSat: number;
  status: string;
  emergency: { status: string[]; choice: string } | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface FfStatusUpdate {
  status: string;
  emergency?: { status: string[]; choice: string } | null;
  depositTxid?: string | null;
}

interface Row {
  payment_hash: string;
  order_id: string;
  order_token: string;
  ff_code: string;
  asset: string;
  unit: string;
  deposit_address: string;
  deposit_tag: string | null;
  deposit_amount: string;
  deposit_txid: string | null;
  invoice_amount_sat: number;
  status: string;
  emergency_json: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

export class FfOrderStore {
  constructor(private db: Db, private ttlMs: number, private now: () => number = Date.now) {}

  /** Settlement, corridor recovery and order in one transaction: an order whose settlement
   *  row is missing could never be reconciled to a payer. */
  createAccepted(record: AcceptedFfOrder): void {
    const at = this.now();
    const o = record.order;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "INSERT INTO settlements (payment_hash, pr, session_id, settled, preimage, swap_id, payment_option, payment_destination, amount_msat, address_id, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(record.paymentHash, record.pr, record.sessionId, record.preimage, record.recovery.rfqId, record.paymentOption, o.depositAddress, record.amountMsat, record.addressId ?? null, at, at);
      insertOfflineSwap(this.db, record.paymentHash, record.recovery, at);
      this.db.prepare(
        "INSERT INTO ff_orders (payment_hash, order_id, order_token, ff_code, asset, unit, deposit_address, deposit_tag, deposit_amount, invoice_amount_sat, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(record.paymentHash, o.id, o.token, o.ffCode, o.asset, o.unit, o.depositAddress, o.depositTag ?? null, o.depositAmount, o.invoiceAmountSat, o.status, o.expiresAt, at, at);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Orders the poller still asks FixedFloat about: any not DONE (a late deposit revives an
   *  EXPIRED one), and a DONE one whose settled row still lacks its deposit txid. */
  listOpen(): StoredFfOrder[] {
    const rows = this.db.prepare(
      `SELECT f.* FROM ff_orders f JOIN settlements s ON s.payment_hash = f.payment_hash
       WHERE f.created_at > ? AND (f.status != 'DONE'
         OR (f.deposit_txid IS NULL AND s.settled = 1 AND s.payment_reference IS NULL))
       ORDER BY f.created_at`,
    ).all(this.now() - this.ttlMs) as unknown as Row[];
    return rows.map(toOrder);
  }

  /** Settled deposits that left the poll list, within one TTL past it, still with no reference. */
  listUnreferencedPastTtl(): StoredFfOrder[] {
    const cutoff = this.now() - this.ttlMs;
    const rows = this.db.prepare(
      `SELECT f.* FROM ff_orders f JOIN settlements s ON s.payment_hash = f.payment_hash
       WHERE s.settled = 1 AND s.payment_reference IS NULL AND f.created_at <= ? AND f.created_at > ?`,
    ).all(cutoff, cutoff - this.ttlMs) as unknown as Row[];
    return rows.map(toOrder);
  }

  byPaymentHash(paymentHash: string): StoredFfOrder | undefined {
    const row = this.db.prepare("SELECT * FROM ff_orders WHERE payment_hash = ?").get(paymentHash) as unknown as Row | undefined;
    return row ? toOrder(row) : undefined;
  }

  byOrderId(orderId: string): StoredFfOrder | undefined {
    const row = this.db.prepare("SELECT * FROM ff_orders WHERE order_id = ?").get(orderId) as unknown as Row | undefined;
    return row ? toOrder(row) : undefined;
  }

  /** Whether the corridor swap behind an order has settled. */
  isSettled(orderId: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM ff_orders f JOIN settlements s ON s.payment_hash = f.payment_hash WHERE f.order_id = ? AND s.settled = 1",
    ).get(orderId));
  }

  /** Unexpired orders nobody has funded yet, in all or for one receiving address: the open-order caps' count. */
  countAwaitingDeposit(nowSec: number, addressId?: number): number {
    const sql = "SELECT COUNT(*) AS n FROM ff_orders f JOIN settlements s ON s.payment_hash = f.payment_hash WHERE f.status = 'NEW' AND f.expires_at > ?";
    const row = addressId === undefined
      ? this.db.prepare(sql).get(nowSec)
      : this.db.prepare(`${sql} AND s.address_id = ?`).get(nowSec, addressId);
    return (row as { n: number }).n;
  }

  /** What FixedFloat last said. Never touches `settled`: that comes from the corridor alone.
   *  A deposit txid is recorded once and becomes a settled row's missing paymentReference. */
  recordStatus(paymentHash: string, update: FfStatusUpdate): { changed: boolean } {
    const row = this.db.prepare("SELECT status, emergency_json, deposit_txid FROM ff_orders WHERE payment_hash = ?").get(paymentHash) as
      | Pick<Row, "status" | "emergency_json" | "deposit_txid">
      | undefined;
    if (!row) return { changed: false };
    const emergencyJson = update.emergency ? JSON.stringify(update.emergency) : null;
    const changed = row.status !== update.status || row.emergency_json !== emergencyJson;
    const at = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (changed) {
        this.db.prepare("UPDATE ff_orders SET status = ?, emergency_json = ?, updated_at = ? WHERE payment_hash = ?").run(update.status, emergencyJson, at, paymentHash);
      }
      if (update.depositTxid && !row.deposit_txid) {
        this.db.prepare("UPDATE ff_orders SET deposit_txid = ?, updated_at = ? WHERE payment_hash = ?").run(update.depositTxid, at, paymentHash);
      }
      this.fillReference(paymentHash);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { changed };
  }

  /** Copy the recorded deposit txid into a settled row that has no reference yet. */
  fillReference(paymentHash: string): boolean {
    return this.db.prepare(
      `UPDATE settlements SET payment_reference = (SELECT deposit_txid FROM ff_orders WHERE payment_hash = ?), updated_at = ?
       WHERE payment_hash = ? AND settled = 1 AND payment_reference IS NULL
         AND (SELECT deposit_txid FROM ff_orders WHERE payment_hash = ?) IS NOT NULL`,
    ).run(paymentHash, this.now(), paymentHash, paymentHash).changes > 0;
  }
}

function toOrder(row: Row): StoredFfOrder {
  return {
    paymentHash: row.payment_hash,
    orderId: row.order_id,
    token: row.order_token,
    ffCode: row.ff_code,
    asset: row.asset,
    unit: row.unit,
    depositAddress: row.deposit_address,
    depositTag: row.deposit_tag,
    depositAmount: row.deposit_amount,
    depositTxid: row.deposit_txid,
    invoiceAmountSat: row.invoice_amount_sat,
    status: row.status,
    emergency: row.emergency_json ? (JSON.parse(row.emergency_json) as StoredFfOrder["emergency"]) : null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
