import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService, ProvisioningError } from "../src/address-service.js";
import { deriveSessionId } from "../src/session-id.js";

const KEY = randomBytes(32);
let db: Db; let repos: Repositories; let svc: AddressService; let domainId: number;
const TOKEN = "ab".repeat(32);

beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  svc = new AddressService(repos, KEY);
  domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self", "random"] }).id;
});

function domain() { return repos.domains.getById(domainId)!; }

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
