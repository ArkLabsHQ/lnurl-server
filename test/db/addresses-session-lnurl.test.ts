import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories, type Repositories } from "../../src/db/repositories/index.js";

const SID = "a".repeat(32);

let db: Db;
let repos: Repositories;
let d: { id: number };

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  repos = createRepositories(db);
  d = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] });
});

describe("AddressesRepo session_lnurl", () => {
  it("flags a session-lnurl row and finds it by domain + session id", () => {
    const row = repos.addresses.create({ domainId: d.id, username: SID, status: "active", sessionId: SID, sessionLnurl: true });
    expect(row.sessionLnurl).toBe(true);
    expect(repos.addresses.getSessionLnurl(d.id, SID)?.id).toBe(row.id);
    repos.addresses.rename(row.id, "Alice");
    expect(repos.addresses.getSessionLnurl(d.id, SID)?.username).toBe("alice");
  });

  it("allows a new flagged row once the previous one is revoked", () => {
    const a = repos.addresses.create({ domainId: d.id, username: SID, status: "active", sessionId: SID, sessionLnurl: true });
    repos.addresses.rename(a.id, "old-name");
    repos.addresses.updateStatus(a.id, "revoked");
    expect(() => repos.addresses.create({ domainId: d.id, username: SID, status: "active", sessionId: SID, sessionLnurl: true })).not.toThrow();
  });

  it("rejects a second active flagged row for the same session", () => {
    repos.addresses.create({ domainId: d.id, username: SID, status: "active", sessionId: SID, sessionLnurl: true });
    expect(() => repos.addresses.create({ domainId: d.id, username: "x", status: "active", sessionId: SID, sessionLnurl: true })).toThrow();
  });
});
