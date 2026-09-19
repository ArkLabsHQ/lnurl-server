import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import {
  COVENANT_SUPPLY_MAX,
  COVENANT_SUPPLY_SCHEME,
  CovenantSupplyStore,
  SupplyError,
  profileMatches,
} from "../src/covenant-supply.js";

const kat = JSON.parse(readFileSync(new URL("./fixtures/covenant-entropy-kat.json", import.meta.url), "utf8")) as {
  covenant: { entries: { index: number; preimage: string }[] };
  swap: { entries: { index: number; preimage: string }[] };
};

const KEY = randomBytes(32);
const hexAt = (i: number) => Buffer.from(new Uint8Array(32).fill(i)).toString("hex");
const upload = (startIndex: number, preimages: string[]) => ({ scheme: COVENANT_SUPPLY_SCHEME, startIndex, preimages });

let db: Db;
let store: CovenantSupplyStore;
let addressId: number;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO domains (domain, allocation_modes, created_at, updated_at) VALUES ('d.example', '[\"self\"]', 1, 1)").run();
  const info = db.prepare("INSERT INTO addresses (domain_id, username, status, created_at, updated_at) VALUES (1, 'alice', 'active', 1, 1)").run();
  addressId = Number(info.lastInsertRowid);
  store = new CovenantSupplyStore(db, KEY);
});
afterEach(() => db.close());

describe("CovenantSupplyStore", () => {
  it("starts empty at index zero", () => {
    expect(store.state(addressId)).toEqual({ nextIndex: 0, remaining: 0, scheme: null });
  });

  it("round-trips the preimages it was given", () => {
    const preimages = kat.covenant.entries.map((e) => e.preimage);
    expect(store.accept(addressId, upload(0, preimages))).toEqual({
      nextIndex: 3,
      remaining: 3,
      scheme: COVENANT_SUPPLY_SCHEME,
    });
    for (const [index, expected] of preimages.entries()) {
      expect(Buffer.from(store.at(addressId, index)!.preimage).toString("hex")).toBe(expected);
    }
  });

  it("stores the ciphertext, never the preimage", () => {
    store.accept(addressId, upload(0, [kat.covenant.entries[0]!.preimage]));
    const row = db.prepare("SELECT ciphertext, iv, tag FROM covenant_commitments WHERE address_id = ? AND idx = 0").get(addressId) as
      { ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array };
    expect(Buffer.from(row.ciphertext).toString("hex")).not.toContain(kat.covenant.entries[0]!.preimage);
    expect(row.iv).toHaveLength(12);
    expect(row.tag).toHaveLength(16);
  });

  it("throws rather than returning junk under the wrong key", () => {
    store.accept(addressId, upload(0, [hexAt(1)]));
    const wrong = new CovenantSupplyStore(db, randomBytes(32));
    expect(() => wrong.allocate(addressId)).toThrow();
  });

  it("allocates strictly ascending and never twice", () => {
    store.accept(addressId, upload(0, [hexAt(1), hexAt(2), hexAt(3)]));
    const seen = [store.allocate(addressId), store.allocate(addressId), store.allocate(addressId)];
    expect(seen.map((a) => a!.index)).toEqual([0, 1, 2]);
    expect(seen.map((a) => Buffer.from(a!.preimage).toString("hex"))).toEqual([hexAt(1), hexAt(2), hexAt(3)]);
    expect(store.allocate(addressId)).toBeUndefined();
  });

  it("hands no index out twice across interleaved callers", () => {
    const count = 32;
    store.accept(addressId, upload(0, Array.from({ length: count }, (_, i) => hexAt(i + 1))));
    const other = new CovenantSupplyStore(db, KEY);
    const taken: number[] = [];
    for (let i = 0; i < count; i++) {
      taken.push((i % 2 === 0 ? store : other).allocate(addressId)!.index);
    }
    expect(new Set(taken).size).toBe(count);
    expect(taken).toEqual([...taken].sort((a, b) => a - b));
  });

  it("does not release a consumed index when the caller fails afterwards", () => {
    store.accept(addressId, upload(0, [hexAt(1), hexAt(2)]));
    expect(store.allocate(addressId)!.index).toBe(0);
    expect(store.allocate(addressId)!.index).toBe(1);
    expect(store.state(addressId)).toEqual({ nextIndex: 2, remaining: 0, scheme: COVENANT_SUPPLY_SCHEME });
  });

  it("keeps the two legs on separate supplies", () => {
    store.accept(addressId, upload(0, [kat.covenant.entries[0]!.preimage]), "covenant");
    store.accept(addressId, upload(0, [kat.swap.entries[0]!.preimage]), "swap");
    expect(Buffer.from(store.allocate(addressId, "covenant")!.preimage).toString("hex")).toBe(kat.covenant.entries[0]!.preimage);
    expect(Buffer.from(store.allocate(addressId, "swap")!.preimage).toString("hex")).toBe(kat.swap.entries[0]!.preimage);
    expect(store.allocate(addressId, "covenant")).toBeUndefined();
  });

  it("appends the next batch at the reported nextIndex", () => {
    store.accept(addressId, upload(0, [hexAt(1)]));
    expect(store.accept(addressId, upload(1, [hexAt(2)])).nextIndex).toBe(2);
  });

  it("treats an identical re-post as a no-op", () => {
    const batch = upload(0, [hexAt(1), hexAt(2)]);
    store.accept(addressId, batch);
    expect(store.accept(addressId, batch)).toEqual({ nextIndex: 2, remaining: 2, scheme: COVENANT_SUPPLY_SCHEME });
    expect(db.prepare("SELECT COUNT(*) AS c FROM covenant_commitments").get()).toEqual({ c: 2 });
  });

  it("rejects a re-post at the same index with different bytes", () => {
    store.accept(addressId, upload(0, [hexAt(1)]));
    expect(() => store.accept(addressId, upload(0, [hexAt(9)]))).toThrow(SupplyError);
  });

  it("rejects an unknown scheme, a gap, bad hex and an oversize batch", () => {
    expect(() => store.accept(addressId, { scheme: "hd-v9", startIndex: 0, preimages: [hexAt(1)] })).toThrow(/unknown covenant supply scheme/);
    expect(() => store.accept(addressId, upload(4, [hexAt(1)]))).toThrow(/must be 0/);
    expect(() => store.accept(addressId, upload(0, ["ff"]))).toThrow(/32 bytes of hex/);
    expect(() => store.accept(addressId, upload(0, []))).toThrow(/non-empty/);
    expect(() =>
      store.accept(addressId, upload(0, Array.from({ length: COVENANT_SUPPLY_MAX + 1 }, (_, i) => hexAt(i % 251)))),
    ).toThrow(/at most 256/);
  });

  it("refuses any supply when the encryption key is source-readable", () => {
    const insecure = new CovenantSupplyStore(db, KEY, { insecureKeyStorage: true });
    expect(() => insecure.accept(addressId, upload(0, [hexAt(1)]))).toThrow(/ALLOW_INSECURE_TOKEN_STORAGE/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM covenant_commitments").get()).toEqual({ c: 0 });
  });

  // What the recovery view serves: a destination the server already handed out
  // is the one the owner most needs to rebuild.
  it("still reads back an index after it has been consumed", () => {
    store.accept(addressId, upload(0, [hexAt(1)]));
    expect(store.allocate(addressId)!.index).toBe(0);
    expect(Buffer.from(store.at(addressId, 0)!.preimage).toString("hex")).toBe(hexAt(1));
  });
});

describe("profileMatches", () => {
  const actual = { recoveryDelaySeconds: 86_528, emulatorPubkey: "AB".repeat(32) };

  it("accepts an equal profile regardless of key case", () => {
    expect(profileMatches({ recoveryDelaySeconds: 86_528, emulatorPubkey: "ab".repeat(32) }, actual)).toBe(true);
  });

  it("rejects a different delay or a different emulator key", () => {
    expect(profileMatches({ recoveryDelaySeconds: 4096, emulatorPubkey: "ab".repeat(32) }, actual)).toBe(false);
    expect(profileMatches({ recoveryDelaySeconds: 86_528, emulatorPubkey: "cd".repeat(32) }, actual)).toBe(false);
  });
});
