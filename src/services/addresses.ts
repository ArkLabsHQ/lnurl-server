import { randomBytes } from "node:crypto";
import type { Repositories } from "../db/repositories/index.js";
import type { ClaimCodeRow } from "../db/repositories/claim-codes.js";
import type { AddressRow, DomainRow } from "../types/index.js";
import { encryptToken, hashSecret } from "../crypto.js";
import { deriveSessionId, isValidToken } from "../session-token.js";
import { validateUsername, randomUsername } from "../usernames.js";
import { normalizeDisabledRails } from "../rails.js";
import type { PaymentMethod } from "../payment-methods.js";
import { InvalidRailPolicyError, ProvisioningError } from "../errors.js";

const MAX_RANDOM_ATTEMPTS = 20;
const HEX_HANDLE = /^[0-9a-f]{32}$/;

/** A flagged row is nameless only while it hasn't been given a name; the flag itself survives upgrade. */
export const isNameless = (a: AddressRow): boolean => a.sessionLnurl && a.username === a.sessionId;

export class AddressService {
  constructor(private repos: Repositories, private key: Buffer) {}

  register(p: { domain: DomainRow; username?: string; token: string; claimCode?: string }): {
    address: AddressRow;
    lightningAddress: string;
    created: boolean;
  } {
    const { domain, token } = p;
    if (!isValidToken(token)) throw new ProvisioningError("invalid_token", "token must be hex of length >= 32");
    const sessionId = deriveSessionId(token);

    if (p.username) {
      const username = p.username.toLowerCase();
      const existing = this.repos.addresses.getByDomainAndUsername(domain.id, username);
      if (existing && existing.status === "reserved") {
        this.assertReservationCode(domain, existing, p.claimCode);
        this.enforceMax(domain, sessionId);
        this.repos.addresses.bind(existing.id, { sessionId, encryptedToken: encryptToken(token, this.key) });
        return this.result(domain, username, true);
      }
      // A claim whose second step (the identity bind) failed leaves the row behind; the same
      // session retrying gets it back rather than being locked out of its own name. Ownership is
      // the sessionId every other owner route checks, so this reveals nothing listByToken doesn't.
      if (existing && existing.status === "active" && existing.sessionId === sessionId && !isNameless(existing)) {
        return this.result(domain, username, false);
      }
      if (existing) throw new ProvisioningError("taken", "username already taken");
      const code = this.freeNameCode(domain, username, p.claimCode);
      this.enforceMax(domain, sessionId);
      this.repos.transaction(() => {
        const address = this.repos.addresses.create({ domainId: domain.id, username, status: "active", sessionId, encryptedToken: encryptToken(token, this.key) });
        if (code) this.spend(code, address.id);
      });
      return this.result(domain, username, true);
    }

    if (p.claimCode) {
      const reserved = this.reservationFor(domain, p.claimCode);
      this.enforceMax(domain, sessionId);
      this.repos.addresses.bind(reserved.id, { sessionId, encryptedToken: encryptToken(token, this.key) });
      return this.result(domain, reserved.username, true);
    }

    if (!domain.allocationModes.includes("random")) throw new ProvisioningError("forbidden_mode", "random allocation disabled");
    this.enforceMax(domain, sessionId);
    const username = this.pickRandomUsername(domain);
    this.repos.addresses.create({ domainId: domain.id, username, status: "active", sessionId, encryptedToken: encryptToken(token, this.key) });
    return this.result(domain, username, true);
  }

  registerNameless(p: { domain: DomainRow; token: string }): { address: AddressRow; created: boolean } {
    if (!isValidToken(p.token)) throw new ProvisioningError("invalid_token", "token must be hex of length >= 32");
    if (!p.domain.allocationModes.includes("session")) throw new ProvisioningError("forbidden_mode", "nameless receivers disabled");
    const sessionId = deriveSessionId(p.token);
    const existing = this.repos.addresses.getSessionLnurl(p.domain.id, sessionId);
    if (existing) return { address: existing, created: false };
    this.enforceMax(p.domain, sessionId);
    // Reclaim only a row we can prove was ours and never named; any other holder of the sid as a
    // username (a hex name predating the reservation, foreign, or reserved) blocks us instead of being taken over.
    const holder = this.repos.addresses.getByDomainAndUsername(p.domain.id, sessionId);
    if (holder && holder.sessionId === sessionId && holder.status === "revoked") {
      this.repos.addresses.updateStatus(holder.id, "active");
      return { address: this.repos.addresses.getById(holder.id)!, created: true };
    }
    if (holder) throw new ProvisioningError("taken", "username already taken");
    const address = this.repos.addresses.create({
      domainId: p.domain.id, username: sessionId, status: "active", sessionId,
      encryptedToken: encryptToken(p.token, this.key), sessionLnurl: true,
    });
    return { address, created: true };
  }

  upgrade(p: { domain: DomainRow; handle: string; token: string; username?: string; claimCode?: string }): AddressRow {
    if (!isValidToken(p.token)) throw new ProvisioningError("invalid_token", "token must be hex of length >= 32");
    const a = this.ownedByHandle(p.domain, p.handle, p.token);
    if (!a || a.status !== "active") throw new ProvisioningError("not_found", "address not found or not owned by this token");
    if (!isNameless(a)) throw new ProvisioningError("already_named", "address already has a name");
    return this.repos.transaction(() => {
      const username = this.pickUpgradeName(p.domain, a, p.username, p.claimCode);
      this.repos.addresses.rename(a.id, username);
      return this.repos.addresses.getById(a.id)!;
    });
  }

  /** The row `handle` names for this token's owner. A flagged row stays reachable by its session id after
   *  an upgrade, so a device still holding the nameless handle keeps working. */
  ownedByHandle(domain: DomainRow, handle: string, token: string): AddressRow | undefined {
    if (!isValidToken(token)) return undefined;
    const h = handle.toLowerCase();
    const a = this.repos.addresses.getByDomainAndUsername(domain.id, h)
      ?? (HEX_HANDLE.test(h) ? this.repos.addresses.getSessionLnurl(domain.id, h) : undefined);
    return a && a.sessionId === deriveSessionId(token) ? a : undefined;
  }

  reserve(domain: DomainRow, username: string): { address: AddressRow; claimCode: string } {
    const u = username.toLowerCase();
    if (this.repos.addresses.getByDomainAndUsername(domain.id, u)) throw new ProvisioningError("taken", "username already taken");
    this.assertUsername(domain, u);
    const claimCode = randomBytes(16).toString("hex");
    const address = this.repos.addresses.create({ domainId: domain.id, username: u, status: "reserved", claimCodeHash: hashSecret(claimCode) });
    return { address, claimCode };
  }

  /** A single-use code for any free name its holder picks on this domain, `self` mode or not. */
  issueClaimCode(domain: DomainRow): { code: ClaimCodeRow; claimCode: string } {
    const claimCode = randomBytes(16).toString("hex");
    return { code: this.repos.claimCodes.create(domain.id, hashSecret(claimCode)), claimCode };
  }

  mint(domain: DomainRow, username: string): { address: AddressRow; secret: string } {
    const u = username.toLowerCase();
    if (this.repos.addresses.getByDomainAndUsername(domain.id, u)) throw new ProvisioningError("taken", "username already taken");
    this.assertUsername(domain, u);
    const secret = randomBytes(32).toString("hex");
    const address = this.repos.addresses.create({
      domainId: domain.id, username: u, status: "active",
      sessionId: deriveSessionId(secret), encryptedToken: encryptToken(secret, this.key),
    });
    return { address, secret };
  }

  listByToken(token: string): AddressRow[] {
    if (!isValidToken(token)) return [];
    return this.repos.addresses.listBySessionId(deriveSessionId(token));
  }

  revokeOwn(domain: DomainRow, handle: string, token: string): boolean {
    const a = this.ownedByHandle(domain, handle, token);
    if (!a) return false;
    this.repos.addresses.updateStatus(a.id, "revoked");
    return true;
  }

  /** Replace the per-address rail policy (operator-controlled, per LNURL). */
  setRailPolicy(id: number, rails: unknown): void {
    let normalized;
    try {
      normalized = normalizeDisabledRails(rails);
    } catch (err) {
      if (err instanceof InvalidRailPolicyError) throw new ProvisioningError("invalid_rails", err.message);
      throw err;
    }
    this.repos.addresses.setDisabledRails(id, normalized);
  }

  /** Set the Arkade receive identity for offline receive on an owned address. */
  setOfflineReceive(
    domain: DomainRow,
    handle: string,
    token: string,
    cfg: { arkadeAddress: string; claimPublicKey: string; boardingAddress?: string; methods?: PaymentMethod[] },
  ): boolean {
    const a = this.ownedByHandle(domain, handle, token);
    if (!a || a.status !== "active") return false;
    this.repos.addresses.setOfflineReceive(a.id, cfg.arkadeAddress, cfg.claimPublicKey);
    // Only when named: a caller re-registering its identity without one should
    // not silently withdraw an onchain rail it registered earlier.
    if (cfg.boardingAddress !== undefined) {
      this.repos.addresses.setBoardingAddress(a.id, cfg.boardingAddress);
    }
    if (cfg.methods !== undefined) {
      this.repos.addresses.setPaymentMethods(a.id, cfg.methods);
    }
    return true;
  }

  private result(domain: DomainRow, username: string, created: boolean) {
    return { address: this.repos.addresses.getByDomainAndUsername(domain.id, username)!, lightningAddress: `${username}@${domain.domain}`, created };
  }

  private assertUsername(domain: DomainRow, username: string): void {
    if (!validateUsername(username, domain)) throw new ProvisioningError("invalid_username", "username violates domain rules");
    if (HEX_HANDLE.test(username)) throw new ProvisioningError("invalid_username", "username looks like a session handle");
    if (this.repos.blacklist.isBlocked(domain.id, username)) throw new ProvisioningError("blacklisted", "username is blacklisted");
  }

  /** Mirrors register()'s branches without creating a row. */
  private pickUpgradeName(domain: DomainRow, target: AddressRow, username?: string, claimCode?: string): string {
    if (username) {
      const name = username.toLowerCase();
      const existing = this.repos.addresses.getByDomainAndUsername(domain.id, name);
      if (existing && existing.status === "reserved") {
        this.assertReservationCode(domain, existing, claimCode);
        this.absorbReservation(target, existing);
        return name;
      }
      if (existing) throw new ProvisioningError("taken", "username already taken");
      const code = this.freeNameCode(domain, name, claimCode);
      if (code) this.spend(code, target.id);
      return name;
    }
    if (claimCode) {
      const reserved = this.reservationFor(domain, claimCode);
      this.absorbReservation(target, reserved);
      return reserved.username;
    }
    if (!domain.allocationModes.includes("random")) throw new ProvisioningError("forbidden_mode", "random allocation disabled");
    return this.pickRandomUsername(domain);
  }

  private absorbReservation(target: AddressRow, reserved: AddressRow): void {
    // Union, not replace: both policies are the operator's, and dropping either re-enables a rail they turned off.
    this.repos.addresses.setDisabledRails(target.id, normalizeDisabledRails([...target.disabledRails, ...reserved.disabledRails]));
    this.repos.addresses.delete(reserved.id);
  }

  /** A reservation opens only to its own code. A free code offered for it means the name is someone else's. */
  private assertReservationCode(domain: DomainRow, reserved: AddressRow, claimCode?: string): void {
    const hash = claimCode ? hashSecret(claimCode) : undefined;
    if (hash && reserved.claimCodeHash?.equals(hash)) return;
    if (hash && this.repos.claimCodes.getUnspent(domain.id, hash)) throw new ProvisioningError("taken", "username already taken");
    throw new ProvisioningError("invalid_claim", "invalid or missing claim code");
  }

  /** A new name needs `self` mode or a free claim code. A code that matches nothing is refused, not ignored. */
  private freeNameCode(domain: DomainRow, username: string, claimCode?: string): ClaimCodeRow | undefined {
    const code = claimCode ? this.repos.claimCodes.getUnspent(domain.id, hashSecret(claimCode)) : undefined;
    if (claimCode && !code) throw new ProvisioningError("invalid_claim", "invalid or missing claim code");
    if (!code && !domain.allocationModes.includes("self")) throw new ProvisioningError("forbidden_mode", "self-registration disabled");
    this.assertUsername(domain, username);
    return code;
  }

  /** The reservation a code names on its own. A free code names nothing, so it needs a username beside it. */
  private reservationFor(domain: DomainRow, claimCode: string): AddressRow {
    const hash = hashSecret(claimCode);
    const reserved = this.repos.addresses.getReservedByClaimCode(domain.id, hash);
    if (reserved) return reserved;
    if (this.repos.claimCodes.getUnspent(domain.id, hash)) throw new ProvisioningError("username_required", "this claim code needs a username");
    throw new ProvisioningError("invalid_claim", "invalid or missing claim code");
  }

  private spend(code: ClaimCodeRow, addressId: number): void {
    if (!this.repos.claimCodes.redeem(code.id, addressId)) throw new ProvisioningError("invalid_claim", "claim code already used");
  }

  private enforceMax(domain: DomainRow, sessionId: string): void {
    if (domain.maxPerSession != null && this.repos.addresses.countActiveBySessionId(sessionId) >= domain.maxPerSession) {
      throw new ProvisioningError("limit_reached", "address limit reached for this wallet");
    }
  }

  private pickRandomUsername(domain: DomainRow): string {
    for (let i = 0; i < MAX_RANDOM_ATTEMPTS; i++) {
      const u = randomUsername();
      if (validateUsername(u, domain) && !this.repos.blacklist.isBlocked(domain.id, u) && !this.repos.addresses.getByDomainAndUsername(domain.id, u)) {
        return u;
      }
    }
    // Fall back to a word-combo with a short random hex suffix to break contention.
    // The suffix keeps the name within the default 32-char max (longest combo is 12 chars + 5 = 17).
    for (let i = 0; i < MAX_RANDOM_ATTEMPTS; i++) {
      const u = `${randomUsername()}-${randomBytes(2).toString("hex")}`;
      if (validateUsername(u, domain) && !this.repos.blacklist.isBlocked(domain.id, u) && !this.repos.addresses.getByDomainAndUsername(domain.id, u)) {
        return u;
      }
    }
    throw new ProvisioningError("taken", "could not allocate a free random username");
  }
}
