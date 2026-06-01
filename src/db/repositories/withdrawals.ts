import type { Db } from "../connection.js";

export type WithdrawalStatus = "active" | "used" | "expired";

export interface WithdrawalRow {
  id: string;
  sessionId: string;
  minWithdrawable: number;
  maxWithdrawable: number;
  description: string | null;
  status: WithdrawalStatus;
  usesRemaining: number;
  createdAt: number;
  expiresAt: number | null;
  usedAt: number | null;
}

interface WithdrawalRecord {
  id: string;
  session_id: string;
  min_withdrawable: number;
  max_withdrawable: number;
  description: string | null;
  status: string;
  uses_remaining: number;
  created_at: number;
  expires_at: number | null;
  used_at: number | null;
}

function rowTo(r: WithdrawalRecord): WithdrawalRow {
  return {
    id: r.id, sessionId: r.session_id, minWithdrawable: r.min_withdrawable, maxWithdrawable: r.max_withdrawable,
    description: r.description, status: r.status as WithdrawalStatus, usesRemaining: r.uses_remaining,
    createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at,
  };
}

export interface CreateWithdrawalParams {
  id: string;
  sessionId: string;
  minWithdrawable: number;
  maxWithdrawable: number;
  description?: string;
  usesRemaining?: number;
  expiresAt?: number | null;
}

export class WithdrawalsRepo {
  constructor(private db: Db) {}

  create(p: CreateWithdrawalParams): WithdrawalRow {
    this.db
      .prepare(
        `INSERT INTO withdrawals
           (id, session_id, min_withdrawable, max_withdrawable, description, status, uses_remaining, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
      )
      .run(p.id, p.sessionId, p.minWithdrawable, p.maxWithdrawable, p.description ?? null, p.usesRemaining ?? 1, Date.now(), p.expiresAt ?? null);
    return this.get(p.id)!;
  }

  get(id: string): WithdrawalRow | undefined {
    const r = this.db.prepare("SELECT * FROM withdrawals WHERE id = ?").get(id) as WithdrawalRecord | undefined;
    return r ? rowTo(r) : undefined;
  }

  markUsed(id: string): void {
    this.db.prepare(
      `UPDATE withdrawals
         SET uses_remaining = uses_remaining - 1,
             status   = CASE WHEN uses_remaining - 1 <= 0 THEN 'used' ELSE status END,
             used_at  = CASE WHEN uses_remaining - 1 <= 0 THEN ?      ELSE used_at END
       WHERE id = ? AND uses_remaining > 0`,
    ).run(Date.now(), id);
  }

  markExpired(id: string): void {
    this.db.prepare("UPDATE withdrawals SET status = 'expired' WHERE id = ?").run(id);
  }

  listBySession(sessionId: string): WithdrawalRow[] {
    const rows = this.db.prepare("SELECT * FROM withdrawals WHERE session_id = ? ORDER BY created_at DESC").all(sessionId) as unknown as WithdrawalRecord[];
    return rows.map(rowTo);
  }

  list(filter: { status?: WithdrawalStatus } = {}): WithdrawalRow[] {
    const sql = filter.status
      ? "SELECT * FROM withdrawals WHERE status = ? ORDER BY created_at DESC"
      : "SELECT * FROM withdrawals ORDER BY created_at DESC";
    const rows = (filter.status ? this.db.prepare(sql).all(filter.status) : this.db.prepare(sql).all()) as WithdrawalRecord[];
    return rows.map(rowTo);
  }
}
