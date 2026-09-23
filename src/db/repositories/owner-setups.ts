import type { Db } from "../connection.js";

export type SetupIntent = "enroll" | "update" | "rotate" | "revoke";
export type IdentityState = "active" | "revoked";

/** One accepted revision, holding exactly the bytes the owner signed. */
export interface OwnerSetupRecord {
  domain: string;
  username: string;
  tenant: string;
  revision: number;
  digest: string;
  previousDigest: string | null;
  intent: SetupIntent;
  payload: Uint8Array;
  signature: Uint8Array;
  countersignature: Uint8Array | null;
  /** On a rotation, the old owner: the key whose signature was checked. */
  signerPublicKey: Uint8Array;
  /** The key this revision grants. */
  ownerPublicKey: Uint8Array;
  acceptedAt: number;
}

/** An identity's current head. With no address it is a tombstone: the name stays bound
 *  to its owner key, and only a revision that owner signs can link it again. */
export interface OwnerIdentity {
  domain: string;
  username: string;
  tenant: string;
  addressId: number | null;
  currentRevision: number;
  currentDigest: string;
  ownerPublicKey: Uint8Array;
  state: IdentityState;
  suspendedAt: number | null;
  suspensionReason: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SetupRow {
  domain: string;
  username: string;
  tenant: string;
  revision: number;
  digest: string;
  previous_digest: string | null;
  intent: SetupIntent;
  payload: Uint8Array;
  signature: Uint8Array;
  countersignature: Uint8Array | null;
  signer_public_key: Uint8Array;
  owner_public_key: Uint8Array;
  accepted_at: number;
}

interface IdentityRow {
  domain: string;
  username: string;
  tenant: string;
  address_id: number | null;
  current_revision: number;
  current_digest: string;
  owner_public_key: Uint8Array;
  state: IdentityState;
  suspended_at: number | null;
  suspension_reason: string | null;
  created_at: number;
  updated_at: number;
}

const toRecord = (r: SetupRow): OwnerSetupRecord => ({
  domain: r.domain, username: r.username, tenant: r.tenant, revision: r.revision, digest: r.digest,
  previousDigest: r.previous_digest, intent: r.intent, payload: r.payload, signature: r.signature,
  countersignature: r.countersignature, signerPublicKey: r.signer_public_key, ownerPublicKey: r.owner_public_key,
  acceptedAt: r.accepted_at,
});

const toIdentity = (r: IdentityRow): OwnerIdentity => ({
  domain: r.domain, username: r.username, tenant: r.tenant, addressId: r.address_id, currentRevision: r.current_revision,
  currentDigest: r.current_digest, ownerPublicKey: r.owner_public_key, state: r.state, suspendedAt: r.suspended_at,
  suspensionReason: r.suspension_reason, createdAt: r.created_at, updatedAt: r.updated_at,
});

// Deliberately without a delete: nothing in the application may erase a signed
// revision or an identity, which is what makes an identity a tombstone.
export class OwnerSetupsRepo {
  constructor(private db: Db) {}

  identity(domain: string, username: string): OwnerIdentity | undefined {
    const r = this.db.prepare("SELECT * FROM owner_identities WHERE domain = ? AND username = ?").get(domain, username) as IdentityRow | undefined;
    return r ? toIdentity(r) : undefined;
  }

  identityByAddress(addressId: number): OwnerIdentity | undefined {
    const r = this.db.prepare("SELECT * FROM owner_identities WHERE address_id = ?").get(addressId) as IdentityRow | undefined;
    return r ? toIdentity(r) : undefined;
  }

  current(domain: string, username: string): OwnerSetupRecord | undefined {
    const r = this.db.prepare(
      `SELECT s.* FROM owner_setups s JOIN owner_identities i ON s.digest = i.current_digest
        WHERE i.domain = ? AND i.username = ?`,
    ).get(domain, username) as SetupRow | undefined;
    return r ? toRecord(r) : undefined;
  }

  history(domain: string, username: string, limit: number): OwnerSetupRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM owner_setups WHERE domain = ? AND username = ? ORDER BY revision DESC LIMIT ?",
    ).all(domain, username, limit) as unknown as SetupRow[];
    return rows.map(toRecord);
  }

  countForDomain(domain: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM owner_identities WHERE domain = ?").get(domain) as { n: number }).n;
  }

  /** Runs fn atomically. Savepoints nest, so a caller can commit an address row and the
   *  identity that claims it as one unit. */
  transaction<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT owner_setups");
    try {
      const out = fn();
      this.db.exec("RELEASE owner_setups");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK TO owner_setups");
      this.db.exec("RELEASE owner_setups");
      throw error;
    }
  }

  /** Makes a verified revision the identity's head, atomically. A revision that does not
   *  chain from the committed head is refused here too, not only by the caller. */
  append(record: OwnerSetupRecord, head: { addressId: number | null; state: IdentityState }): void {
    this.transaction(() => {
      this.db.prepare(
        `INSERT INTO owner_setups (domain, username, tenant, revision, digest, previous_digest, intent, payload,
           signature, countersignature, signer_public_key, owner_public_key, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.domain, record.username, record.tenant, record.revision, record.digest, record.previousDigest, record.intent,
        record.payload, record.signature, record.countersignature, record.signerPublicKey, record.ownerPublicKey, record.acceptedAt,
      );
      if (record.revision === 1) {
        this.db.prepare(
          `INSERT INTO owner_identities (domain, username, tenant, address_id, current_revision, current_digest,
             owner_public_key, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        ).run(record.domain, record.username, record.tenant, head.addressId, record.digest, record.ownerPublicKey, head.state, record.acceptedAt, record.acceptedAt);
      } else {
        const moved = this.db.prepare(
          `UPDATE owner_identities SET current_revision = ?, current_digest = ?, owner_public_key = ?, state = ?,
             address_id = ?, updated_at = ?
           WHERE domain = ? AND username = ? AND current_revision = ? AND current_digest = ?`,
        ).run(
          record.revision, record.digest, record.ownerPublicKey, head.state, head.addressId, record.acceptedAt,
          record.domain, record.username, record.revision - 1, record.previousDigest,
        );
        if (moved.changes !== 1) throw new Error("owner setup revision does not chain from the committed head");
      }
    });
  }

  /** Availability only: the signed head is untouched. `null` lifts a suspension. */
  suspend(domain: string, username: string, reason: string | null): void {
    const now = Date.now();
    this.db.prepare(
      "UPDATE owner_identities SET suspended_at = ?, suspension_reason = ?, updated_at = ? WHERE domain = ? AND username = ?",
    ).run(reason === null ? null : now, reason, now, domain, username);
  }
}
