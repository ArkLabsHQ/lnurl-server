import { randomBytes } from "node:crypto";
import type { Repositories } from "./db/repositories/index.js";
import type { AddressRow, DomainRow } from "./db/types.js";
import { encryptToken, hashSecret } from "./crypto.js";
import { deriveSessionId } from "./session-id.js";
import { validateUsername, randomUsername, isValidToken } from "./usernames.js";
import { normalizeDisabledRails } from "./rails.js";

export type ProvisioningCode =
  | "invalid_token" | "invalid_username" | "forbidden_mode"
  | "blacklisted" | "taken" | "limit_reached" | "invalid_claim" | "invalid_rails" | "stale_credential" | "protected_address";

export class ProvisioningError extends Error {
  constructor(public code: ProvisioningCode, message: string) {
    super(message);
    this.name = "ProvisioningError";
  }
}

const MAX_RANDOM_ATTEMPTS = 20;

export class AddressService {
  constructor(private repos: Repositories, private key: Buffer) {}

  register(p: { domain: DomainRow; username?: string; token: string; claimCode?: string }): {
    address: AddressRow;
    lightningAddress: string;
  } {
    const { domain, token } = p;
    if (!isValidToken(token)) throw new ProvisioningError("invalid_token", "token must be hex of length >= 32");
    const sessionId = deriveSessionId(token);

    if (p.username) {
      const username = p.username.toLowerCase();
      this.assertUnprotected(domain, username);
      const existing = this.repos.addresses.getByDomainAndUsername(domain.id, username);
      if (existing && existing.status === "reserved") {
        if (!p.claimCode || !existing.claimCodeHash || !hashSecret(p.claimCode).equals(existing.claimCodeHash)) {
          throw new ProvisioningError("invalid_claim", "invalid or missing claim code");
        }
        this.enforceMax(domain, sessionId);
        this.repos.addresses.bind(existing.id, { sessionId, encryptedToken: encryptToken(token, this.key) });
        return this.result(domain, username);
      }
      if (existing) throw new ProvisioningError("taken", "username already taken");
      if (!domain.allocationModes.includes("self")) throw new ProvisioningError("forbidden_mode", "self-registration disabled");
      this.assertUsername(domain, username);
      this.enforceMax(domain, sessionId);
      this.repos.addresses.create({ domainId: domain.id, username, status: "active", sessionId, encryptedToken: encryptToken(token, this.key) });
      return this.result(domain, username);
    }

    if (!domain.allocationModes.includes("random")) throw new ProvisioningError("forbidden_mode", "random allocation disabled");
    this.enforceMax(domain, sessionId);
    const username = this.pickRandomUsername(domain);
    this.repos.addresses.create({ domainId: domain.id, username, status: "active", sessionId, encryptedToken: encryptToken(token, this.key) });
    return this.result(domain, username);
  }

  reserve(domain: DomainRow, username: string): { address: AddressRow; claimCode: string } {
    const u = username.toLowerCase();
    this.assertUnprotected(domain, u);
    if (this.repos.addresses.getByDomainAndUsername(domain.id, u)) throw new ProvisioningError("taken", "username already taken");
    this.assertUsername(domain, u);
    const claimCode = randomBytes(16).toString("hex");
    const address = this.repos.addresses.create({ domainId: domain.id, username: u, status: "reserved", claimCodeHash: hashSecret(claimCode) });
    return { address, claimCode };
  }

  mint(domain: DomainRow, username: string): { address: AddressRow; secret: string } {
    const u = username.toLowerCase();
    this.assertUnprotected(domain, u);
    if (this.repos.addresses.getByDomainAndUsername(domain.id, u)) throw new ProvisioningError("taken", "username already taken");
    this.assertUsername(domain, u);
    const secret = randomBytes(32).toString("hex");
    const address = this.repos.addresses.create({
      domainId: domain.id, username: u, status: "active",
      sessionId: deriveSessionId(secret), encryptedToken: encryptToken(secret, this.key),
    });
    return { address, secret };
  }

  /** The address a newly enrolled protected identity claims. It never adopts an existing
   *  row, nor a token already bound to one: importing an old credential confers nothing. */
  createProtected(domain: DomainRow, username: string, token: string): AddressRow {
    if (!isValidToken(token)) throw new ProvisioningError("invalid_token", "token must be hex of length >= 32");
    const sessionId = deriveSessionId(token);
    if (this.repos.addresses.listBySessionId(sessionId).length > 0) {
      throw new ProvisioningError("stale_credential", "this token is already bound to an address; enroll with a fresh one");
    }
    if (this.repos.addresses.getByDomainAndUsername(domain.id, username)) throw new ProvisioningError("taken", "username already taken");
    if (!domain.allocationModes.includes("self")) throw new ProvisioningError("forbidden_mode", "self-registration disabled");
    this.assertUsername(domain, username);
    return this.repos.addresses.create({ domainId: domain.id, username, status: "active", sessionId, encryptedToken: encryptToken(token, this.key) });
  }

  listByToken(token: string): AddressRow[] {
    if (!isValidToken(token)) return [];
    return this.repos.addresses.listBySessionId(deriveSessionId(token));
  }

  revokeOwn(domain: DomainRow, username: string, token: string): boolean {
    if (!isValidToken(token)) return false;
    const a = this.repos.addresses.getByDomainAndUsername(domain.id, username.toLowerCase());
    if (!a || a.sessionId !== deriveSessionId(token)) return false;
    this.assertUnprotected(domain, a.username);
    this.repos.addresses.updateStatus(a.id, "revoked");
    return true;
  }

  /** Replace the per-address rail policy (operator-controlled, per LNURL). */
  setRailPolicy(id: number, rails: unknown): void {
    if (this.repos.ownerSetups.identityByAddress(id)) {
      throw new ProvisioningError("protected_address", "this address is owner-signed; its rails change only through a signed setup (POST /lnurl/setup)");
    }
    let normalized;
    try {
      normalized = normalizeDisabledRails(rails);
    } catch (err) {
      throw new ProvisioningError("invalid_rails", err instanceof Error ? err.message : "invalid rail policy");
    }
    this.repos.addresses.setDisabledRails(id, normalized);
  }

  /** Set the Arkade receive identity for offline receive on an owned address. */
  setOfflineReceive(
    domain: DomainRow,
    username: string,
    token: string,
    cfg: { arkadeAddress: string; claimPublicKey: string; boardingAddress?: string },
  ): boolean {
    if (!isValidToken(token)) return false;
    const a = this.repos.addresses.getByDomainAndUsername(domain.id, username.toLowerCase());
    if (!a || a.sessionId !== deriveSessionId(token) || a.status !== "active") return false;
    this.assertUnprotected(domain, a.username);
    this.repos.addresses.setOfflineReceive(a.id, cfg.arkadeAddress, cfg.claimPublicKey);
    // Only when named: a caller re-registering its identity without one should
    // not silently withdraw an onchain rail it registered earlier.
    if (cfg.boardingAddress !== undefined) {
      this.repos.addresses.setBoardingAddress(a.id, cfg.boardingAddress);
    }
    return true;
  }

  private result(domain: DomainRow, username: string) {
    return { address: this.repos.addresses.getByDomainAndUsername(domain.id, username)!, lightningAddress: `${username}@${domain.domain}` };
  }

  /** A name an owner identity holds, tombstone included, moves only through a signed setup:
   *  neither its bearer token nor an operator may rewrite, retire or reassign it. */
  private assertUnprotected(domain: DomainRow, username: string): void {
    if (this.repos.ownerSetups.identity(domain.domain, username)) {
      throw new ProvisioningError("protected_address", `${username}@${domain.domain} is owner-signed; only a signed setup (POST /lnurl/setup) changes it`);
    }
  }

  private isFree(domain: DomainRow, username: string): boolean {
    return validateUsername(username, domain) && !this.repos.blacklist.isBlocked(domain.id, username)
      && !this.repos.addresses.getByDomainAndUsername(domain.id, username) && !this.repos.ownerSetups.identity(domain.domain, username);
  }

  private assertUsername(domain: DomainRow, username: string): void {
    if (!validateUsername(username, domain)) throw new ProvisioningError("invalid_username", "username violates domain rules");
    if (this.repos.blacklist.isBlocked(domain.id, username)) throw new ProvisioningError("blacklisted", "username is blacklisted");
  }

  private enforceMax(domain: DomainRow, sessionId: string): void {
    if (domain.maxPerSession != null && this.repos.addresses.countActiveBySessionId(sessionId) >= domain.maxPerSession) {
      throw new ProvisioningError("limit_reached", "address limit reached for this wallet");
    }
  }

  private pickRandomUsername(domain: DomainRow): string {
    for (let i = 0; i < MAX_RANDOM_ATTEMPTS; i++) {
      const u = randomUsername();
      if (this.isFree(domain, u)) return u;
    }
    // Fall back to a word-combo with a short random hex suffix to break contention.
    // The suffix keeps the name within the default 32-char max (longest combo is 12 chars + 5 = 17).
    for (let i = 0; i < MAX_RANDOM_ATTEMPTS; i++) {
      const u = `${randomUsername()}-${randomBytes(2).toString("hex")}`;
      if (this.isFree(domain, u)) return u;
    }
    throw new ProvisioningError("taken", "could not allocate a free random username");
  }
}
