import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";

describe("node:sqlite availability", () => {
  it("opens an in-memory db and round-trips a row", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a INTEGER)");
    db.prepare("INSERT INTO t (a) VALUES (?)").run(1);
    const row = db.prepare("SELECT a FROM t").get() as { a: number };
    expect(row.a).toBe(1);
    db.close();
  });
});
