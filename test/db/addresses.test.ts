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

describe("AddressesRepo.list pages", () => {
  // b, c and d share a created_at, so only their ids order them.
  const seed = () => {
    const at = { a: 1000, b: 2000, c: 2000, d: 2000, e: 3000 };
    for (const [username, createdAt] of Object.entries(at)) {
      const { id } = repo.create({ domainId, username, status: "active" });
      db.prepare("UPDATE addresses SET created_at = ? WHERE id = ?").run(createdAt, id);
    }
  };
  const names = (rows: { username: string }[]) => rows.map((r) => r.username);
  const after = (rows: { createdAt: number; id: number }[]) => ({ createdAt: rows.at(-1)!.createdAt, id: rows.at(-1)!.id });

  it("pages newest first, ordering equal created_at by id", () => {
    seed();
    const first = repo.list({ limit: 2 });
    expect(names(first)).toEqual(["e", "d"]);
    const second = repo.list({ before: after(first), limit: 2 });
    expect(names(second)).toEqual(["c", "b"]);
    expect(names(repo.list({ before: after(second), limit: 2 }))).toEqual(["a"]);
  });

  it("filters before it limits, on every page", () => {
    seed();
    for (const username of ["b", "d"]) repo.updateStatus(repo.getByDomainAndUsername(domainId, username)!.id, "revoked");
    const first = repo.list({ status: "active", limit: 2 });
    expect(names(first)).toEqual(["e", "c"]);
    expect(names(repo.list({ status: "active", before: after(first), limit: 2 }))).toEqual(["a"]);
    expect(names(repo.list({ q: "d", limit: 2 }))).toEqual(["d"]);
  });

  describe.each<[string, (r: AddressesRepo) => unknown, RegExp]>([
    ["the first page", (r) => r.list({ limit: 201 }), /^SCAN addresses USING INDEX idx_addresses_created$/],
    ["a later page", (r) => r.list({ before: { createdAt: 2000, id: 7 }, limit: 201 }), /^SEARCH addresses USING INDEX idx_addresses_created /],
    ["a later page of a username search", (r) => r.list({ q: "ali", before: { createdAt: 2000, id: 7 }, limit: 201 }), /^SEARCH addresses USING INDEX idx_addresses_created /],
    ["a status filter", (r) => r.list({ status: "revoked", limit: 201 }), /^SCAN addresses USING INDEX idx_addresses_created$/],
    ["the bulk reconcile read", (r) => r.list({ withArkadeAddress: true, limit: 200 }), /^SCAN addresses USING INDEX idx_addresses_created$/],
  ])("%s", (_name, call, plan) => {
    it("walks idx_addresses_created in order, without sorting", () => {
      const prepare = db.prepare.bind(db);
      const seen: string[] = [];
      db.prepare = (sql: string) => (seen.push(sql), prepare(sql));
      try {
        call(repo);
      } finally {
        db.prepare = prepare;
      }
      expect(seen).toHaveLength(1);
      const detail = (db.prepare(`EXPLAIN QUERY PLAN ${seen[0]}`).all() as { detail: string }[]).map((r) => r.detail).join(" | ");
      expect(detail).toMatch(plan);
      expect(detail).not.toContain("TEMP B-TREE");
    });
  });
});
