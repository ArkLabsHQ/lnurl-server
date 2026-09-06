// Dump the solver's sqlite state (receive/send swap rows + wallet vtxos) — the e2e
// workflow's failure dump runs this inside the intent-solver container.
const { createRequire } = require("module");
const req = createRequire("/app/packages/solver-app/dist/cli.js");
const Database = req("better-sqlite3");
const fs = require("fs");
for (const f of fs.readdirSync("/data").filter((f) => f.endsWith(".sqlite"))) {
  console.log("=== " + f);
  const db = new Database("/data/" + f, { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  for (const t of tables) {
    const count = db.prepare("SELECT COUNT(*) c FROM " + t).get().c;
    console.log("  " + t + ": " + count + " rows");
    if (count > 0) {
      for (const r of db.prepare("SELECT * FROM " + t + " ORDER BY rowid DESC LIMIT 10").all()) {
        console.log("   ", JSON.stringify(r, (k, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 800));
      }
    }
  }
}
