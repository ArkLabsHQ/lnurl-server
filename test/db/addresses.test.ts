import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { openDb, type Db } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { DomainsRepo } from "../../src/db/repositories/domains.js";
import { AddressesRepo } from "../../src/db/repositories/addresses.js";
import { encryptToken, decryptToken, hashSecret } from "../../src/crypto.js";

let db: Db;
let domains: DomainsRepo;
let repo: AddressesRepo;
let domainId: number;
const key = randomBytes(32);

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  domains = new DomainsRepo(db);
  repo = new AddressesRepo(db);
  domainId = domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
});

describe("AddressesRepo", () => {
  it("creates an active address with an encrypted token and reads it back", () => {
    const enc = encryptToken("aa".repeat(32), key);
    repo.create({ domainId, username: "devious", status: "active", sessionId: "sid1", encryptedToken: enc });
    const found = repo.getByDomainAndUsername(domainId, "devious")!;
    expect(found.status).toBe("active");
    expect(found.sessionId).toBe("sid1");
    expect(decryptToken(found.encryptedToken!, key)).toBe("aa".repeat(32));
  });

  it("creates a reserved address with a claim code hash and no token", () => {
    repo.create({ domainId, username: "held", status: "reserved", claimCodeHash: hashSecret("code") });
    const found = repo.getByDomainAndUsername(domainId, "held")!;
    expect(found.status).toBe("reserved");
    expect(found.sessionId).toBeNull();
    expect(found.encryptedToken).toBeNull();
    expect(found.claimCodeHash!.equals(hashSecret("code"))).toBe(true);
  });

  it("binds a reserved address (claim): sets token + session, clears claim code, activates", () => {
    const created = repo.create({ domainId, username: "held", status: "reserved", claimCodeHash: hashSecret("c") });
    repo.bind(created.id, { sessionId: "sid2", encryptedToken: encryptToken("bb".repeat(32), key) });
    const found = repo.getByDomainAndUsername(domainId, "held")!;
    expect(found.status).toBe("active");
    expect(found.sessionId).toBe("sid2");
    expect(found.claimCodeHash).toBeNull();
    expect(decryptToken(found.encryptedToken!, key)).toBe("bb".repeat(32));
  });

  it("lists all addresses for a session id across domains", () => {
    const other = domains.create({ domain: "domain2.com", allocationModes: ["self"] }).id;
    repo.create({ domainId, username: "a", status: "active", sessionId: "sid3", encryptedToken: encryptToken("c".repeat(64), key) });
    repo.create({ domainId: other, username: "b", status: "active", sessionId: "sid3", encryptedToken: encryptToken("d".repeat(64), key) });
    expect(repo.listBySessionId("sid3")).toHaveLength(2);
  });

  it("revokes via updateStatus", () => {
    const a = repo.create({ domainId, username: "x", status: "active", sessionId: "s", encryptedToken: encryptToken("e".repeat(64), key) });
    repo.updateStatus(a.id, "revoked");
    expect(repo.getByDomainAndUsername(domainId, "x")!.status).toBe("revoked");
  });

  it("enforces unique (domain, username)", () => {
    repo.create({ domainId, username: "dup", status: "active", sessionId: "s", encryptedToken: encryptToken("f".repeat(64), key) });
    expect(() =>
      repo.create({ domainId, username: "dup", status: "active", sessionId: "s2", encryptedToken: encryptToken("f".repeat(64), key) }),
    ).toThrow();
  });
});
