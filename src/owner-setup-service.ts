import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Repositories } from "./db/repositories/index.js";
import type { OwnerIdentity, OwnerSetupRecord, SetupIntent } from "./db/repositories/owner-setups.js";
import type { AddressRow, DomainRow } from "./db/types.js";
import { ProvisioningError, type AddressService } from "./address-service.js";
import { decodeOwnerSetup, ownerSetupDigest, verifyOwnerSetup, type OwnerSetup } from "./enclave/owner-setup.js";
import { RAIL_IDS, type RailAddress } from "./rails.js";

export class OwnerSetupError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "OwnerSetupError";
  }
}

export interface OwnerSetupServiceOptions {
  deployment: string;
  network: string;
  /** Whether new identities may enroll. Enforcement over existing ones never depends on it. */
  enrollment: boolean;
  now?: () => number;
}

export interface CommittedSetup {
  setup: OwnerSetup;
  identity: OwnerIdentity;
  record: OwnerSetupRecord;
}

export interface SetupSubmission {
  payload: Uint8Array;
  signature: Uint8Array;
  /** The new owner's signature over the same digest, on a rotation. */
  countersignature?: Uint8Array;
  /** A fresh credential, when the submission creates the address row. */
  token?: string;
}

const PROVISIONING: Partial<Record<string, [number, string]>> = {
  taken: [409, "username_taken"],
  stale_credential: [409, "stale_credential"],
  forbidden_mode: [403, "forbidden_mode"],
  limit_reached: [409, "limit_reached"],
};

function sameRouting(a: OwnerSetup, b: OwnerSetup): boolean {
  return a.arkadeDestination === b.arkadeDestination && a.claimPublicKey === b.claimPublicKey
    && a.boardingAddress === b.boardingAddress && a.rails.join() === b.rails.join();
}

/** The committed setup a protected name routes from; undefined for a legacy one. */
export function committedSetup(repos: Repositories, domain: string, username: string): CommittedSetup | undefined {
  const identity = repos.ownerSetups.identity(domain, username);
  if (!identity) return undefined;
  const record = repos.ownerSetups.current(domain, username)!;
  return { setup: decodeOwnerSetup(record.payload), identity, record };
}

/** The owner's preferences in the operator-policy slot: every rail they did not list is disabled. */
export function setupRailAddress(setup: OwnerSetup): RailAddress {
  return {
    arkadeAddress: setup.arkadeDestination, claimPublicKey: setup.claimPublicKey, boardingAddress: setup.boardingAddress ?? null,
    disabledRails: RAIL_IDS.filter((r) => !setup.rails.includes(r)),
  };
}

export function isProtectedSession(repos: Repositories, sessionId: string): boolean {
  return repos.addresses.listBySessionId(sessionId).some((a) => repos.ownerSetups.identityByAddress(a.id) !== undefined);
}

export type ReceiveRouting =
  | { kind: "legacy" | "protected"; railAddress: RailAddress }
  | { kind: "refused"; reason: string };

/** What a payRequest or callback may route through for this row. Protection is found by
 *  name, never through the row, so a row the identity does not claim routes nowhere. */
export function receiveRouting(repos: Repositories, domain: string, address: AddressRow): ReceiveRouting {
  const committed = committedSetup(repos, domain, address.username);
  if (!committed) {
    const { arkadeAddress, claimPublicKey, boardingAddress, disabledRails } = address;
    return { kind: "legacy", railAddress: { arkadeAddress, claimPublicKey, boardingAddress, disabledRails } };
  }
  const { setup, identity } = committed;
  const name = `${address.username}@${domain}`;
  if (identity.addressId !== address.id) return { kind: "refused", reason: "Unknown LN address" };
  if (identity.state === "revoked") return { kind: "refused", reason: `${name} was revoked by its owner` };
  if (identity.suspendedAt !== null) return { kind: "refused", reason: `${name} is suspended by its provider` };
  return { kind: "protected", railAddress: setupRailAddress(setup) };
}

/** The owner-signed setup chain: who may enroll a protected identity, and which signed
 *  revisions may move it. Everything is checked before anything is written. */
export class OwnerSetupService {
  constructor(private repos: Repositories, private addresses: AddressService, private options: OwnerSetupServiceOptions) {}

  current(domain: string, username: string): CommittedSetup | undefined {
    return committedSetup(this.repos, domain, username);
  }

  submit(req: SetupSubmission): CommittedSetup & { applied: boolean } {
    let setup: OwnerSetup;
    try {
      setup = decodeOwnerSetup(req.payload);
    } catch (error) {
      throw new OwnerSetupError(400, "invalid_payload", (error as Error).message);
    }
    if (setup.rails.length === 0 || setup.rails.includes("interactive-lightning")) {
      throw new OwnerSetupError(400, "unsupported_rail", "a protected setup names at least one rail, and never interactive-lightning");
    }
    if (setup.deployment !== this.options.deployment) throw new OwnerSetupError(403, "wrong_deployment", `this setup is for ${setup.deployment}`);
    if (setup.network !== this.options.network) throw new OwnerSetupError(403, "wrong_network", `this setup is for ${setup.network}`);
    const domain = this.repos.domains.getByDomain(setup.domain);
    if (!domain || !domain.enabled) throw new OwnerSetupError(404, "unknown_domain", `no enabled domain ${setup.domain}`);
    if (setup.tenant !== domain.tenant) throw new OwnerSetupError(403, "wrong_tenant", `${setup.domain} belongs to another tenant`);

    const digest = bytesToHex(ownerSetupDigest(setup));
    const identity = this.repos.ownerSetups.identity(setup.domain, setup.username);
    if (identity?.currentDigest === digest) return { applied: false, ...this.current(setup.domain, setup.username)! };
    const now = this.options.now?.() ?? Date.now();
    if (!identity) this.enroll(setup, digest, req, domain, now);
    else this.advance(setup, digest, req, identity, domain, now);
    return { applied: true, ...this.current(setup.domain, setup.username)! };
  }

  private enroll(setup: OwnerSetup, digest: string, req: SetupSubmission, domain: DomainRow, now: number): void {
    if (!this.options.enrollment) throw new OwnerSetupError(403, "enrollment_disabled", "this deployment does not enroll protected identities");
    if (setup.revision !== 1 || setup.intent !== "set") throw new OwnerSetupError(409, "revision_conflict", "an identity starts at revision 1, setting its receive configuration");
    if (!verifyOwnerSetup(setup, req.signature, hexToBytes(setup.ownerPublicKey))) throw new OwnerSetupError(401, "bad_signature", "the owner signature does not verify");
    const record = this.record(setup, digest, req, "enroll", hexToBytes(setup.ownerPublicKey), now);
    this.repos.ownerSetups.transaction(() => {
      const addressId = this.createAddress(domain, setup, req.token);
      this.repos.ownerSetups.append(record, { addressId, state: "active" });
    });
  }

  private advance(setup: OwnerSetup, digest: string, req: SetupSubmission, identity: OwnerIdentity, domain: DomainRow, now: number): void {
    if (setup.revision !== identity.currentRevision + 1 || setup.previousHash !== identity.currentDigest) {
      throw new OwnerSetupError(409, "revision_conflict", `the committed head is revision ${identity.currentRevision}`);
    }
    // After revision 1 only the committed owner key signs, a rotation included; the key
    // a payload names has no authority over the record that grants it.
    if (!verifyOwnerSetup(setup, req.signature, identity.ownerPublicKey)) throw new OwnerSetupError(401, "bad_signature", "the committed owner signature does not verify");
    const rotating = setup.ownerPublicKey !== bytesToHex(identity.ownerPublicKey);
    if (rotating) {
      if (!req.countersignature) throw new OwnerSetupError(409, "countersignature_required", "a rotation needs the new owner key's countersignature");
      if (!verifyOwnerSetup(setup, req.countersignature, hexToBytes(setup.ownerPublicKey))) {
        throw new OwnerSetupError(401, "bad_signature", "the new owner key's countersignature does not verify");
      }
    }
    if (setup.intent === "revoke") {
      if (identity.state === "revoked") throw new OwnerSetupError(409, "already_revoked", "this identity is already revoked");
      const committed = decodeOwnerSetup(this.repos.ownerSetups.current(setup.domain, setup.username)!.payload);
      if (rotating || !sameRouting(setup, committed)) throw new OwnerSetupError(400, "invalid_payload", "a revocation changes nothing but the identity's state");
    }
    const intent: SetupIntent = setup.intent === "revoke" ? "revoke" : rotating ? "rotate" : identity.state === "revoked" ? "enroll" : "update";
    const record = this.record(setup, digest, req, intent, identity.ownerPublicKey, now);
    this.repos.ownerSetups.transaction(() => {
      let addressId = identity.addressId;
      if (setup.intent === "set") {
        if (addressId === null) addressId = this.createAddress(domain, setup, req.token);
        else this.writeThrough(addressId, setup);
      }
      this.repos.ownerSetups.append(record, { addressId, state: setup.intent === "revoke" ? "revoked" : "active" });
    });
  }

  private createAddress(domain: DomainRow, setup: OwnerSetup, token: string | undefined): number {
    if (!token) throw new OwnerSetupError(400, "invalid_token", "creating the address needs a fresh token");
    let id: number;
    try {
      id = this.addresses.createProtected(domain, setup.username, token).id;
    } catch (error) {
      if (!(error instanceof ProvisioningError)) throw error;
      const [status, code] = PROVISIONING[error.code] ?? [400, error.code];
      throw new OwnerSetupError(status, code, error.message);
    }
    this.writeThrough(id, setup);
    return id;
  }

  // Advertising and the admin list read the row; the money path reads only the setup.
  private writeThrough(addressId: number, setup: OwnerSetup): void {
    this.repos.addresses.setOfflineReceive(addressId, setup.arkadeDestination, setup.claimPublicKey);
    this.repos.addresses.setBoardingAddress(addressId, setup.boardingAddress ?? null);
    this.repos.addresses.setDisabledRails(addressId, RAIL_IDS.filter((r) => !setup.rails.includes(r)));
  }

  private record(setup: OwnerSetup, digest: string, req: SetupSubmission, intent: SetupIntent, signer: Uint8Array, now: number): OwnerSetupRecord {
    return {
      domain: setup.domain, username: setup.username, tenant: setup.tenant, revision: setup.revision, digest,
      previousDigest: setup.previousHash ?? null, intent, payload: req.payload, signature: req.signature,
      countersignature: req.countersignature ?? null, signerPublicKey: signer, ownerPublicKey: hexToBytes(setup.ownerPublicKey),
      acceptedAt: now,
    };
  }
}
