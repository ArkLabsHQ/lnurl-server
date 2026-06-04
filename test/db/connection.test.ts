import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/connection.js";

describe("openDb", () => {
  it("enables foreign_keys", () => {
    const db = openDb(":memory:");
    const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
    db.close();
  });
});
