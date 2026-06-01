import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { encryptToken } from "../src/crypto.js";

let db: Db; let repos: Repositories; let domainId: number;
const KEY = randomBytes(32);
beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
});

describe("AddressesRepo.list / delete", () => {
  it("filters by domain, status, and username substring", () => {
    repos.addresses.create({ domainId, username: "devious", status: "active", sessionId: "s", encryptedToken: encryptToken("a".repeat(64), KEY) });
    repos.addresses.create({ domainId, username: "dormant", status: "revoked", sessionId: "s", encryptedToken: encryptToken("b".repeat(64), KEY) });
    expect(repos.addresses.list({ domainId })).toHaveLength(2);
    expect(repos.addresses.list({ domainId, status: "active" })).toHaveLength(1);
    expect(repos.addresses.list({ q: "dev" })).toHaveLength(1);
  });

  it("hard-deletes an address", () => {
    const a = repos.addresses.create({ domainId, username: "gone", status: "active", sessionId: "s", encryptedToken: encryptToken("c".repeat(64), KEY) });
    repos.addresses.delete(a.id);
    expect(repos.addresses.getByDomainAndUsername(domainId, "gone")).toBeUndefined();
  });
});

describe("WithdrawalsRepo.list", () => {
  it("filters by status", () => {
    repos.withdrawals.create({ id: "w1", sessionId: "s", minWithdrawable: 1, maxWithdrawable: 2 });
    repos.withdrawals.create({ id: "w2", sessionId: "s", minWithdrawable: 1, maxWithdrawable: 2 });
    repos.withdrawals.markUsed("w2");
    expect(repos.withdrawals.list()).toHaveLength(2);
    expect(repos.withdrawals.list({ status: "used" })).toHaveLength(1);
  });
});
