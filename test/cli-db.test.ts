import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initPersistence } from "../src/cli.js";
import { DomainsRepo } from "../src/db/repositories/domains.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("initPersistence", () => {
  it("opens, migrates, and bootstraps a DB at DB_PATH", async () => {
    dir = mkdtempSync(join(tmpdir(), "lnurl-"));
    const dbPath = join(dir, "lnurl.db");
    const db = await initPersistence({ dbPath, bootstrapDomain: "domain.com" });
    expect(db).not.toBeNull();
    expect(new DomainsRepo(db!).getByDomain("domain.com")?.domain).toBe("domain.com");
    db!.close();
  });

  it("returns null when no dbPath is configured (in-memory mode)", async () => {
    expect(await initPersistence({ dbPath: undefined, bootstrapDomain: undefined })).toBeNull();
  });
});
