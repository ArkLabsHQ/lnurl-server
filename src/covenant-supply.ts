// Client-minted preimages for the covenant rail and the swap rail's VHTLC. The
// server never derives these — the SDK's primitive signs with the private key, so
// only the wallet can reproduce them, which is the point. It stores a batch, hands
// out one index per payment, and never hands the same index out twice. Separate
// tables per leg: a shared supply would give the sweep leaf and the VHTLC one
// secret, so a reveal on either unlocks the other.

import type { Db } from "./db/connection.js";
import { decryptToken, encryptToken, type EncryptedToken } from "./crypto.js";

/** The only supply scheme this version speaks. */
export const COVENANT_SUPPLY_SCHEME = "salted-v1";
/** Most preimages one upload may carry. */
export const COVENANT_SUPPLY_MAX = 256;

export type SupplyLeg = "covenant" | "swap";

const TABLE: Record<SupplyLeg, string> = {
  covenant: "covenant_commitments",
  swap: "swap_commitments",
};

/** Operator config the supplied indices were accepted against: a destination
 *  built under a different profile is a different script. */
export interface CovenantProfile {
  recoveryDelaySeconds: number;
  emulatorPubkey: string;
}

export interface SupplyUpload {
  scheme: string;
  startIndex: number;
  preimages: string[];
}

export interface SupplyState {
  nextIndex: number;
  remaining: number;
  scheme: string | null;
}

export type SupplyRejection =
  | "unknown_scheme"
  | "bad_preimage"
  | "index_gap"
  | "too_many"
  | "insecure_storage";

export class SupplyError extends Error {
  constructor(public code: SupplyRejection, message: string) {
    super(message);
    this.name = "SupplyError";
  }
}

const HEX32 = /^[0-9a-f]{64}$/i;

export interface AllocatedPreimage {
  index: number;
  preimage: Uint8Array;
  scheme: string;
}

interface CommitmentRow {
  idx: number;
  scheme: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

/** Validates and stores one upload, and hands indices back out in order.
 *  `insecureKeyStorage` mirrors ALLOW_INSECURE_TOKEN_STORAGE: under it the key is
 *  a constant in the source, so an upload is refused rather than stored behind a
 *  key anyone with the repo has. */
export class CovenantSupplyStore {
  constructor(
    private db: Db,
    private key: Buffer,
    private opts: { insecureKeyStorage?: boolean; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  state(addressId: number, leg: SupplyLeg = "covenant"): SupplyState {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(idx) + 1, 0) AS next,
                COALESCE(SUM(CASE WHEN consumed_at IS NULL THEN 1 ELSE 0 END), 0) AS remaining,
                MAX(scheme) AS scheme
           FROM ${TABLE[leg]} WHERE address_id = ?`,
      )
      .get(addressId) as { next: number; remaining: number; scheme: string | null };
    return { nextIndex: row.next, remaining: row.remaining, scheme: row.scheme ?? null };
  }

  /** Stores a contiguous batch at the caller's `startIndex`. Re-posting an
   *  identical batch is a no-op so a lost response can be retried; anything else
   *  is refused — a supply the owner cannot map to an index is worse than none. */
  accept(addressId: number, upload: SupplyUpload, leg: SupplyLeg = "covenant"): SupplyState {
    if (this.opts.insecureKeyStorage) {
      throw new SupplyError(
        "insecure_storage",
        "refusing a preimage supply under ALLOW_INSECURE_TOKEN_STORAGE: the encryption key is source-readable",
      );
    }
    if (upload.scheme !== COVENANT_SUPPLY_SCHEME) {
      throw new SupplyError("unknown_scheme", `unknown covenant supply scheme "${upload.scheme}"`);
    }
    if (!Array.isArray(upload.preimages) || upload.preimages.length === 0) {
      throw new SupplyError("bad_preimage", "covenantSupply.preimages must be a non-empty array");
    }
    if (upload.preimages.length > COVENANT_SUPPLY_MAX) {
      throw new SupplyError("too_many", `at most ${COVENANT_SUPPLY_MAX} preimages per upload`);
    }
    for (const p of upload.preimages) {
      if (typeof p !== "string" || !HEX32.test(p)) {
        throw new SupplyError("bad_preimage", "every covenantSupply preimage must be 32 bytes of hex");
      }
    }
    const before = this.state(addressId, leg);
    if (upload.startIndex !== before.nextIndex) {
      if (this.isReplay(addressId, leg, upload)) return before;
      throw new SupplyError(
        "index_gap",
        `covenantSupply.startIndex must be ${before.nextIndex} (the server's nextIndex), got ${upload.startIndex}`,
      );
    }
    const insert = this.db.prepare(
      `INSERT INTO ${TABLE[leg]} (address_id, idx, scheme, ciphertext, iv, tag, consumed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    const createdAt = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [offset, preimage] of upload.preimages.entries()) {
        const enc = encryptToken(preimage.toLowerCase(), this.key);
        insert.run(addressId, upload.startIndex + offset, upload.scheme, enc.ciphertext, enc.iv, enc.tag, createdAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.state(addressId, leg);
  }

  /** Takes the lowest unconsumed index, marking it consumed in the same statement
   *  so two concurrent callers cannot get the same one. Never released on failure:
   *  the owner's scan walks a range, so a burned index is an unfunded address. */
  allocate(addressId: number, leg: SupplyLeg = "covenant"): AllocatedPreimage | undefined {
    const row = this.db
      .prepare(
        `UPDATE ${TABLE[leg]} SET consumed_at = ?
          WHERE address_id = ?
            AND consumed_at IS NULL
            AND idx = (SELECT MIN(idx) FROM ${TABLE[leg]} WHERE address_id = ? AND consumed_at IS NULL)
          RETURNING idx, scheme, ciphertext, iv, tag`,
      )
      .get(this.now(), addressId, addressId) as CommitmentRow | undefined;
    if (!row) return undefined;
    return { index: row.idx, scheme: row.scheme, preimage: this.decrypt(row) };
  }

  /** The preimage at one index, consumed or not; what the recovery view serves. */
  at(addressId: number, index: number, leg: SupplyLeg = "covenant"): AllocatedPreimage | undefined {
    const row = this.db
      .prepare(`SELECT idx, scheme, ciphertext, iv, tag FROM ${TABLE[leg]} WHERE address_id = ? AND idx = ?`)
      .get(addressId, index) as CommitmentRow | undefined;
    if (!row) return undefined;
    return { index: row.idx, scheme: row.scheme, preimage: this.decrypt(row) };
  }

  private decrypt(row: CommitmentRow): Uint8Array {
    const enc: EncryptedToken = {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      tag: Buffer.from(row.tag),
    };
    return Buffer.from(decryptToken(enc, this.key), "hex");
  }

  private isReplay(addressId: number, leg: SupplyLeg, upload: SupplyUpload): boolean {
    return upload.preimages.every((p, offset) => {
      const stored = this.at(addressId, upload.startIndex + offset, leg);
      return stored !== undefined && Buffer.from(stored.preimage).toString("hex") === p.toLowerCase();
    });
  }
}

/** Reject a profile the client did not agree to: a destination under a different
 *  emulator key or CSV delay is a different script. */
export function profileMatches(claimed: CovenantProfile, actual: CovenantProfile): boolean {
  return (
    claimed.recoveryDelaySeconds === actual.recoveryDelaySeconds &&
    claimed.emulatorPubkey.toLowerCase() === actual.emulatorPubkey.toLowerCase()
  );
}
