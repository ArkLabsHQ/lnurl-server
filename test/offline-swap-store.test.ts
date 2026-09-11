import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { OfflineSwapStore } from "../src/offline-swap-store.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("OfflineSwapStore", () => {
  it("atomically restores accepted swap recovery after reopening SQLite", () => {
    const dir = mkdtempSync(join(tmpdir(), "lnurl-offline-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");
    const firstDb = openDb(path);
    runMigrations(firstDb);
    const first = new OfflineSwapStore(firstDb, 60_000, () => 1_000);
    first.createAccepted({
      paymentHash: "aa".repeat(32),
      pr: "lnbc1accepted",
      sessionId: "offline:1",
      preimage: "bb".repeat(32),
      amountMsat: 5_000_000,
      recovery: {
        version: 1,
        solverName: "primary",
        solverPubkey: "11".repeat(32),
        relays: ["wss://relay.example"],
        rfqId: "22".repeat(32),
        lockupAddress: "tark1lockup",
        expectedAmount: 4_999,
        script: { sender: "33".repeat(32) },
      },
    });
    firstDb.close();

    const secondDb = openDb(path);
    runMigrations(secondDb);
    const pending = new OfflineSwapStore(secondDb, 60_000, () => 1_001).listPending();
    expect(pending).toEqual([expect.objectContaining({
      paymentHash: "aa".repeat(32),
      preimage: "bb".repeat(32),
      recovery: expect.objectContaining({ solverName: "primary", relays: ["wss://relay.example"] }),
    })]);
    secondDb.close();
  });

  it("rolls back the settlement when recovery insertion conflicts", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const store = new OfflineSwapStore(db, 60_000, () => 1_000);
    const accepted = {
      paymentHash: "aa".repeat(32), pr: "lnbc1", sessionId: "offline:1", preimage: "bb".repeat(32), amountMsat: 1_000,
      recovery: { version: 1 as const, solverName: "one", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"], rfqId: "22".repeat(32), lockupAddress: "tark1", expectedAmount: 1, script: {} },
    };
    store.createAccepted(accepted);
    expect(() => store.createAccepted({ ...accepted, paymentHash: "cc".repeat(32) })).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM settlements").get()).toEqual({ n: 1 });
    db.close();
  });

  it.each(["https://relay.example", "not a URL"])("rejects a persisted non-Nostr relay: %s", (relay) => {
    const db = openDb(":memory:");
    runMigrations(db);
    const store = new OfflineSwapStore(db, 60_000, () => 1_000);
    store.createAccepted({
      paymentHash: "aa".repeat(32), pr: "lnbc1", sessionId: "offline:1", preimage: "bb".repeat(32), amountMsat: 1_000,
      recovery: { version: 1, solverName: "one", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"], rfqId: "22".repeat(32), lockupAddress: "tark1", expectedAmount: 1, script: {} },
    });
    db.prepare("UPDATE offline_swaps SET relays_json = ?").run(JSON.stringify([relay]));

    expect(() => store.listPending()).toThrow("invalid offline swap relays");
    db.close();
  });

  it("rejects a persisted recovery with no relays", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const store = new OfflineSwapStore(db, 60_000, () => 1_000);
    store.createAccepted({
      paymentHash: "aa".repeat(32), pr: "lnbc1", sessionId: "offline:1", preimage: "bb".repeat(32), amountMsat: 1_000,
      recovery: { version: 1, solverName: "one", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"], rfqId: "22".repeat(32), lockupAddress: "tark1", expectedAmount: 1, script: {} },
    });
    db.prepare("UPDATE offline_swaps SET relays_json = '[]'").run();

    expect(() => store.listPending()).toThrow("invalid offline swap relays");
    db.close();
  });
});
