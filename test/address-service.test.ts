import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService, ProvisioningError, isNameless } from "../src/address-service.js";
import { deriveSessionId } from "../src/session-id.js";
import type { DomainRow } from "../src/types/index.js";

const KEY = randomBytes(32);
let db: Db; let repos: Repositories; let svc: AddressService; let domainId: number;
const TOKEN = "ab".repeat(32);
const OTHER = "cd".repeat(32);

beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  svc = new AddressService(repos, KEY);
  domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self", "random"] }).id;
});

function domain() { return repos.domains.getById(domainId)!; }

describe("AddressService.setOfflineReceive", () => {
  it("stores the arkade receive identity for the owning token", () => {
    svc.register({ domain: domain(), username: "devious", token: TOKEN });
    const ok = svc.setOfflineReceive(domain(), "devious", TOKEN, {
      arkadeAddress: "tark1qexample",
      claimPublicKey: "02" + "ab".repeat(32),
    });
    expect(ok).toBe(true);
    const a = repos.addresses.getByDomainAndUsername(domainId, "devious")!;
    expect(a.arkadeAddress).toBe("tark1qexample");
    expect(a.claimPublicKey).toBe("02" + "ab".repeat(32));
  });

  it("rejects a non-owner token and leaves the address unchanged", () => {
    svc.register({ domain: domain(), username: "devious", token: TOKEN });
    const ok = svc.setOfflineReceive(domain(), "devious", "cd".repeat(32), {
      arkadeAddress: "tark1qexample",
      claimPublicKey: "02" + "ab".repeat(32),
    });
    expect(ok).toBe(false);
    expect(repos.addresses.getByDomainAndUsername(domainId, "devious")!.arkadeAddress).toBeNull();
  });
});

describe("AddressService.register", () => {
  it("self-registers a chosen username and binds the token", () => {
    const r = svc.register({ domain: domain(), username: "devious", token: TOKEN });
    expect(r.lightningAddress).toBe("devious@domain.com");
    const a = repos.addresses.getByDomainAndUsername(domainId, "devious")!;
    expect(a.status).toBe("active");
    expect(a.sessionId).toBe(deriveSessionId(TOKEN));
  });

  it("random-allocates when no username is given", () => {
    const r = svc.register({ domain: domain(), token: TOKEN });
    expect(r.lightningAddress).toMatch(/^[a-z-]+@domain\.com$/);
  });

  it("rejects self-registration when 'self' mode is off", () => {
    repos.domains.update(domainId, { allocationModes: ["random"] });
    expect(() => svc.register({ domain: domain(), username: "x", token: TOKEN })).toThrow(ProvisioningError);
  });

  it("rejects a blacklisted username", () => {
    repos.blacklist.add({ domainId: null, username: "admin" });
    expect(() => svc.register({ domain: domain(), username: "admin", token: TOKEN })).toThrow(/blacklist/i);
  });

  it("rejects a taken username", () => {
    svc.register({ domain: domain(), username: "dup", token: TOKEN });
    expect(() => svc.register({ domain: domain(), username: "dup", token: "cd".repeat(32) })).toThrow(/taken/i);
  });

  it("returns the owner's existing row when the same token re-registers", () => {
    const first = svc.register({ domain: domain(), username: "dup", token: TOKEN });
    const again = svc.register({ domain: domain(), username: "dup", token: TOKEN });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.address.id).toBe(first.address.id);
    expect(again.lightningAddress).toBe("dup@domain.com");
    expect(repos.addresses.list({ domainId })).toHaveLength(1);
  });

  it("does not spend the per-session limit on a re-registration", () => {
    svc.register({ domain: domain(), username: "one", token: TOKEN });
    repos.domains.update(domainId, { maxPerSession: 1 });
    expect(svc.register({ domain: domain(), username: "one", token: TOKEN }).created).toBe(false);
  });

  it("keeps 'taken' for the same token's revoked row, so DELETE stays final", () => {
    svc.register({ domain: domain(), username: "gone", token: TOKEN });
    svc.revokeOwn(domain(), "gone", TOKEN);
    expect(() => svc.register({ domain: domain(), username: "gone", token: TOKEN }))
      .toThrow(expect.objectContaining({ code: "taken" }));
  });

  it("enforces max_per_session", () => {
    repos.domains.update(domainId, { maxPerSession: 1 });
    svc.register({ domain: domain(), username: "one", token: TOKEN });
    expect(() => svc.register({ domain: domain(), username: "two", token: TOKEN })).toThrow(/limit/i);
  });
});

describe("reserve + claim + mint", () => {
  it("reserves a name then claims it with the claim code", () => {
    const { claimCode } = svc.reserve(domain(), "held");
    expect(repos.addresses.getByDomainAndUsername(domainId, "held")!.status).toBe("reserved");
    const r = svc.register({ domain: domain(), username: "held", token: TOKEN, claimCode });
    expect(r.lightningAddress).toBe("held@domain.com");
    expect(repos.addresses.getByDomainAndUsername(domainId, "held")!.status).toBe("active");
  });

  it("returns the claimed row when the claiming token repeats the claim", () => {
    const { claimCode } = svc.reserve(domain(), "held");
    const first = svc.register({ domain: domain(), username: "held", token: TOKEN, claimCode });
    const again = svc.register({ domain: domain(), username: "held", token: TOKEN, claimCode });
    expect(again.created).toBe(false);
    expect(again.address.id).toBe(first.address.id);
    expect(again.address.sessionId).toBe(deriveSessionId(TOKEN));
  });

  it("refuses a second session replaying a consumed claim code", () => {
    const { claimCode } = svc.reserve(domain(), "held");
    svc.register({ domain: domain(), username: "held", token: TOKEN, claimCode });
    expect(() => svc.register({ domain: domain(), username: "held", token: OTHER, claimCode }))
      .toThrow(expect.objectContaining({ code: "taken" }));
    expect(repos.addresses.getByDomainAndUsername(domainId, "held")!.sessionId).toBe(deriveSessionId(TOKEN));
  });

  it("rejects a claim with the wrong code", () => {
    svc.reserve(domain(), "held");
    expect(() => svc.register({ domain: domain(), username: "held", token: TOKEN, claimCode: "nope" })).toThrow(/claim/i);
  });

  it("mints an address with a server-generated secret", () => {
    const { secret, address } = svc.mint(domain(), "given");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(address.sessionId).toBe(deriveSessionId(secret));
    expect(address.status).toBe("active");
  });
});

describe("list + revokeOwn", () => {
  it("lists by token and revokes only the owner's address", () => {
    svc.register({ domain: domain(), username: "mine", token: TOKEN });
    expect(svc.listByToken(TOKEN)).toHaveLength(1);
    expect(svc.revokeOwn(domain(), "mine", "ff".repeat(32))).toBe(false); // not owner
    expect(svc.revokeOwn(domain(), "mine", TOKEN)).toBe(true);
    expect(repos.addresses.getByDomainAndUsername(domainId, "mine")!.status).toBe("revoked");
  });
});

describe("edge cases", () => {
  it("register with an invalid token throws ProvisioningError(invalid_token)", () => {
    expect(() => svc.register({ domain: domain(), username: "x", token: "tooshort" }))
      .toThrow(expect.objectContaining({ code: "invalid_token" }));
  });

  it("random allocation when random mode is disabled throws ProvisioningError(forbidden_mode)", () => {
    repos.domains.update(domainId, { allocationModes: ["self"] });
    expect(() => svc.register({ domain: domain(), token: TOKEN }))
      .toThrow(expect.objectContaining({ code: "forbidden_mode" }));
  });

  it("listByToken with an invalid token returns empty array", () => {
    expect(svc.listByToken("nothexa")).toEqual([]);
  });
});

describe("AddressService — session mode, nameless register, upgrade", () => {
  let sessionDomain: DomainRow, selfOnlyDomain: DomainRow, selfDomain: DomainRow, allModes: DomainRow;

  beforeEach(() => {
    sessionDomain = repos.domains.create({ domain: "session.example", allocationModes: ["session"] });
    selfOnlyDomain = repos.domains.create({ domain: "selfonly.example", allocationModes: ["self"] });
    selfDomain = repos.domains.create({ domain: "self.example", allocationModes: ["self"] });
    allModes = repos.domains.create({ domain: "all.example", allocationModes: ["self", "random", "admin", "session"] });
  });

  it("registers a nameless row idempotently", () => {
    const first = svc.registerNameless({ domain: sessionDomain, token: TOKEN });
    const again = svc.registerNameless({ domain: sessionDomain, token: TOKEN });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.address.id).toBe(first.address.id);
    expect(first.address.username).toBe(deriveSessionId(TOKEN));
    expect(isNameless(first.address)).toBe(true);
  });

  it("does not hand the owner its own nameless row back through the named path", () => {
    const { address } = svc.registerNameless({ domain: allModes, token: TOKEN });
    expect(() => svc.register({ domain: allModes, token: TOKEN, username: address.username }))
      .toThrow(expect.objectContaining({ code: "taken" }));
  });

  it("refuses nameless without the session mode", () => {
    expect(() => svc.registerNameless({ domain: selfOnlyDomain, token: TOKEN })).toThrow(expect.objectContaining({ code: "forbidden_mode" }));
  });

  it("reserves hex handles in every mode", () => {
    const hex = "a".repeat(32);
    expect(() => svc.register({ domain: selfDomain, token: TOKEN, username: hex })).toThrow(expect.objectContaining({ code: "invalid_username" }));
    expect(() => svc.reserve(selfDomain, hex)).toThrow(expect.objectContaining({ code: "invalid_username" }));
    expect(() => svc.mint(selfDomain, hex)).toThrow(expect.objectContaining({ code: "invalid_username" }));
  });

  it("refuses to upgrade to a hex handle, whatever its case, leaving the row nameless", () => {
    const { address } = svc.registerNameless({ domain: allModes, token: TOKEN });
    expect(() => svc.upgrade({ domain: allModes, handle: address.username, token: TOKEN, username: "AB".repeat(16) }))
      .toThrow(expect.objectContaining({ code: "invalid_username" }));
    expect(isNameless(repos.addresses.getById(address.id)!)).toBe(true);
  });

  it("upgrades in place, keeping id and session flag, lowercasing the name", () => {
    const { address } = svc.registerNameless({ domain: allModes, token: TOKEN });
    const up = svc.upgrade({ domain: allModes, handle: address.username, token: TOKEN, username: "Alice" });
    expect(up.id).toBe(address.id);
    expect(up.username).toBe("alice");
    expect(up.sessionLnurl).toBe(true);
    expect(isNameless(up)).toBe(false);
  });

  it("upgrades to a random name when none is given", () => {
    const { address } = svc.registerNameless({ domain: allModes, token: TOKEN });
    const up = svc.upgrade({ domain: allModes, handle: address.username, token: TOKEN });
    expect(up.username).not.toBe(address.username);
  });

  it("upgrades onto a reserved name with its claim code, consuming the reservation", () => {
    const { claimCode } = svc.reserve(allModes, "bob");
    const { address } = svc.registerNameless({ domain: allModes, token: TOKEN });
    const up = svc.upgrade({ domain: allModes, handle: address.username, token: TOKEN, username: "bob", claimCode });
    expect(up.id).toBe(address.id);
    expect(repos.addresses.list({ domainId: allModes.id }).filter((a) => a.username === "bob")).toHaveLength(1);
  });

  it("keeps the reserved row's rail policy when upgrading onto it", () => {
    const { address: reserved, claimCode } = svc.reserve(allModes, "bob");
    svc.setRailPolicy(reserved.id, ["arkade"]);
    const { address } = svc.registerNameless({ domain: allModes, token: TOKEN });
    svc.setRailPolicy(address.id, ["onchain"]);
    const up = svc.upgrade({ domain: allModes, handle: address.username, token: TOKEN, username: "bob", claimCode });
    expect([...up.disabledRails].sort()).toEqual(["arkade", "onchain"]);
  });

  it("leaves the reservation and the target's policy untouched when the rename fails", () => {
    const { address: reserved, claimCode } = svc.reserve(allModes, "bob");
    svc.setRailPolicy(reserved.id, ["arkade"]);
    const { address } = svc.registerNameless({ domain: allModes, token: TOKEN });
    svc.setRailPolicy(address.id, ["onchain"]);
    vi.spyOn(repos.addresses, "rename").mockImplementation(() => { throw new Error("rename failed"); });

    expect(() => svc.upgrade({ domain: allModes, handle: address.username, token: TOKEN, username: "bob", claimCode })).toThrow("rename failed");

    const stillReserved = repos.addresses.getById(reserved.id)!;
    expect(stillReserved.status).toBe("reserved");
    expect(stillReserved.disabledRails).toEqual(["arkade"]);
    const target = repos.addresses.getById(address.id)!;
    expect(target.disabledRails).toEqual(["onchain"]);
    expect(isNameless(target)).toBe(true);
  });

  it("resolves an upgraded row's session id for its owner only", () => {
    const { address } = svc.registerNameless({ domain: allModes, token: TOKEN });
    svc.upgrade({ domain: allModes, handle: address.username, token: TOKEN, username: "zed" });
    expect(svc.ownedByHandle(allModes, address.username, TOKEN)?.id).toBe(address.id);
    expect(svc.ownedByHandle(allModes, address.username.toUpperCase(), TOKEN)?.id).toBe(address.id);
    expect(svc.ownedByHandle(allModes, address.username, OTHER)).toBeUndefined();
    expect(svc.setOfflineReceive(allModes, address.username, TOKEN, { arkadeAddress: "tark1q", claimPublicKey: "02" + "ab".repeat(32) })).toBe(true);
    expect(svc.revokeOwn(allModes, address.username, TOKEN)).toBe(true);
    expect(repos.addresses.getById(address.id)!.status).toBe("revoked");
  });

  it("refuses to upgrade a named row, a foreign token, or a taken name", () => {
    const { address } = svc.registerNameless({ domain: allModes, token: TOKEN });
    svc.register({ domain: allModes, token: OTHER, username: "carol" });
    expect(() => svc.upgrade({ domain: allModes, handle: address.username, token: OTHER, username: "x" })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => svc.upgrade({ domain: allModes, handle: address.username, token: TOKEN, username: "carol" })).toThrow(expect.objectContaining({ code: "taken" }));
    svc.upgrade({ domain: allModes, handle: address.username, token: TOKEN, username: "dave" });
    expect(() => svc.upgrade({ domain: allModes, handle: "dave", token: TOKEN, username: "eve" })).toThrow(expect.objectContaining({ code: "already_named" }));
  });

  it("reactivates the owner's revoked nameless row instead of colliding on its username", () => {
    const { address } = svc.registerNameless({ domain: sessionDomain, token: TOKEN });
    svc.revokeOwn(sessionDomain, address.username, TOKEN);
    const again = svc.registerNameless({ domain: sessionDomain, token: TOKEN });
    expect(again.address.id).toBe(address.id);
    expect(again.address.status).toBe("active");
  });

  it("refuses to reactivate a hex-named row owned by a different session", () => {
    const sid = deriveSessionId(TOKEN);
    const foreign = repos.addresses.create({ domainId: sessionDomain.id, username: sid, status: "active", sessionId: deriveSessionId(OTHER) });
    expect(() => svc.registerNameless({ domain: sessionDomain, token: TOKEN })).toThrow(expect.objectContaining({ code: "taken" }));
    expect(repos.addresses.getById(foreign.id)!.status).toBe("active");
    expect(repos.addresses.getById(foreign.id)!.sessionId).toBe(deriveSessionId(OTHER));
  });

  it("refuses to reactivate a hex-named row that is reserved", () => {
    const sid = deriveSessionId(TOKEN);
    const reserved = repos.addresses.create({ domainId: sessionDomain.id, username: sid, status: "reserved" });
    expect(() => svc.registerNameless({ domain: sessionDomain, token: TOKEN })).toThrow(expect.objectContaining({ code: "taken" }));
    expect(repos.addresses.getById(reserved.id)!.status).toBe("reserved");
  });

  it("does not count an upgrade against maxPerSession", () => {
    const capped = repos.domains.create({ domain: "capped.example", allocationModes: ["session", "self"], maxPerSession: 1 });
    const { address } = svc.registerNameless({ domain: capped, token: TOKEN });
    expect(() => svc.upgrade({ domain: capped, handle: address.username, token: TOKEN, username: "frank" })).not.toThrow();
  });
});
