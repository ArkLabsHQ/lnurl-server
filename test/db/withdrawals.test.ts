import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { WithdrawalsRepo } from "../../src/db/repositories/withdrawals.js";

let db: Db; let repo: WithdrawalsRepo;
beforeEach(() => { db = openDb(":memory:"); runMigrations(db); repo = new WithdrawalsRepo(db); });

describe("WithdrawalsRepo", () => {
  it("creates and reads a withdrawal with defaults", () => {
    repo.create({ id: "w1", sessionId: "s1", minWithdrawable: 1000, maxWithdrawable: 50000 });
    const w = repo.get("w1")!;
    expect(w.status).toBe("active");
    expect(w.usesRemaining).toBe(1);
    expect(w.maxWithdrawable).toBe(50000);
  });

  it("markUsed decrements and flips to 'used' at zero", () => {
    repo.create({ id: "w2", sessionId: "s1", minWithdrawable: 1, maxWithdrawable: 2, usesRemaining: 2 });
    repo.markUsed("w2");
    expect(repo.get("w2")!.usesRemaining).toBe(1);
    expect(repo.get("w2")!.status).toBe("active");
    repo.markUsed("w2");
    expect(repo.get("w2")!.status).toBe("used");
    expect(repo.get("w2")!.usedAt).not.toBeNull();
  });

  it("lists by session and marks expired", () => {
    repo.create({ id: "w3", sessionId: "s2", minWithdrawable: 1, maxWithdrawable: 2 });
    expect(repo.listBySession("s2")).toHaveLength(1);
    repo.markExpired("w3");
    expect(repo.get("w3")!.status).toBe("expired");
  });
});
