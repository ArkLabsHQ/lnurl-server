import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories } from "../../src/db/repositories/index.js";
import { OwnerSetupsRepo, type OwnerSetupRecord } from "../../src/db/repositories/owner-setups.js";

function fixture() {
  const db = openDb(":memory:");
  runMigrations(db);
  const repos = createRepositories(db);
  const domainId = repos.domains.create({ domain: "wallet.example", allocationModes: ["self"] }).id;
  const addressId = repos.addresses.create({ domainId, username: "alice", status: "active" }).id;
  return { db, repos, domainId, addressId };
}

const digest = (n: number) => n.toString(16).padStart(64, "0");

function revision(n: number, over: Partial<OwnerSetupRecord> = {}): OwnerSetupRecord {
  return {
    domain: "wallet.example", username: "alice", tenant: "wallet.example", revision: n,
    digest: digest(n), previousDigest: n === 1 ? null : digest(n - 1), intent: n === 1 ? "enroll" : "update",
    payload: Uint8Array.of(1, n), signature: new Uint8Array(64).fill(n), countersignature: null,
    signerPublicKey: new Uint8Array(32).fill(1), ownerPublicKey: new Uint8Array(32).fill(1), acceptedAt: 1_000 + n,
    ...over,
  };
}

describe("owner setups", () => {
  it("appends a chain and moves the identity's head with it", () => {
    const { db, repos, addressId } = fixture();
    repos.ownerSetups.append(revision(1), { addressId, state: "active" });
    repos.ownerSetups.append(revision(2), { addressId, state: "active" });

    expect(repos.ownerSetups.identity("wallet.example", "alice")).toMatchObject({ currentRevision: 2, currentDigest: digest(2), addressId, state: "active" });
    expect(repos.ownerSetups.identityByAddress(addressId)?.currentRevision).toBe(2);
    expect(repos.ownerSetups.current("wallet.example", "alice")).toMatchObject({ revision: 2, payload: Uint8Array.of(1, 2) });
    expect(repos.ownerSetups.history("wallet.example", "alice", 10).map((r) => r.revision)).toEqual([2, 1]);
    db.close();
  });

  it("refuses a revision that does not chain from the head, and a second first revision", () => {
    const { db, repos, addressId } = fixture();
    repos.ownerSetups.append(revision(1), { addressId, state: "active" });
    expect(() => repos.ownerSetups.append(revision(3), { addressId, state: "active" })).toThrow(/does not chain/);
    expect(() => repos.ownerSetups.append(revision(2, { previousDigest: digest(9) }), { addressId, state: "active" })).toThrow(/does not chain/);
    expect(() => repos.ownerSetups.append(revision(1, { digest: digest(7) }), { addressId, state: "active" })).toThrow();
    expect(repos.ownerSetups.history("wallet.example", "alice", 10)).toHaveLength(1);
    db.close();
  });

  it("keeps the identity when its address row is deleted", () => {
    const { db, repos, addressId } = fixture();
    repos.ownerSetups.append(revision(1), { addressId, state: "active" });
    repos.addresses.delete(addressId);
    expect(repos.ownerSetups.identity("wallet.example", "alice")).toMatchObject({ addressId: null, currentRevision: 1 });
    expect(repos.ownerSetups.current("wallet.example", "alice")?.revision).toBe(1);
    db.close();
  });

  it("keeps the identity when its domain is deleted", () => {
    const { db, repos, domainId, addressId } = fixture();
    repos.ownerSetups.append(revision(1), { addressId, state: "active" });
    repos.domains.delete(domainId);
    expect(repos.addresses.getById(addressId)).toBeUndefined();
    expect(repos.ownerSetups.identity("wallet.example", "alice")).toMatchObject({ addressId: null, currentRevision: 1 });
    expect(repos.ownerSetups.countForDomain("wallet.example")).toBe(1);
    db.close();
  });

  it("exposes no way to delete from either table", () => {
    const methods = Object.getOwnPropertyNames(OwnerSetupsRepo.prototype);
    expect(methods.filter((m) => /delete|remove|purge|drop|clear|reset/i.test(m))).toEqual([]);
  });

  it("records a suspension beside the signed head without touching it", () => {
    const { db, repos, addressId } = fixture();
    repos.ownerSetups.append(revision(1), { addressId, state: "active" });
    repos.ownerSetups.suspend("wallet.example", "alice", "provider review");
    expect(repos.ownerSetups.identity("wallet.example", "alice")).toMatchObject({
      suspensionReason: "provider review", currentDigest: digest(1), currentRevision: 1,
    });
    expect(repos.ownerSetups.identity("wallet.example", "alice")?.suspendedAt).toBeGreaterThan(0);
    repos.ownerSetups.suspend("wallet.example", "alice", null);
    expect(repos.ownerSetups.identity("wallet.example", "alice")).toMatchObject({ suspendedAt: null, suspensionReason: null });
    db.close();
  });

  it("gives every domain a tenant, backfilling those created before migration 15", () => {
    const db = openDb(":memory:");
    runMigrations(db, { upToVersion: 14 });
    db.prepare("INSERT INTO domains (domain, allocation_modes, require_api_key, username_min_len, username_max_len, username_pattern, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("old.example", "[\"self\"]", 0, 1, 32, "a-z0-9._-", 1, 1, 1);
    const repos = createRepositories(db);
    const oldId = (db.prepare("SELECT id FROM domains WHERE domain = ?").get("old.example") as { id: number }).id;
    const address = repos.addresses.create({ domainId: oldId, username: "bob", status: "active" });

    runMigrations(db);
    expect(repos.domains.getById(oldId)?.tenant).toBe("old.example");
    expect(repos.addresses.getById(address.id)).toEqual(address);
    expect(repos.domains.create({ domain: "new.example", allocationModes: ["self"] }).tenant).toBe("new.example");
    db.close();
  });
});
