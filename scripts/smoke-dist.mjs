// Build-time smoke test: boot the BUNDLED dist/cli.js with persistence enabled and
// confirm the node:sqlite-backed DB layer loads. Tests run against TS source, so a
// bundler mangling the `node:sqlite` import (e.g. stripping the `node:` prefix) only
// surfaces at runtime in the built artifact — exactly what broke v0.2.0. Chaining this
// into `pnpm build` makes such a regression fail the build (and the Docker release).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "lnurl-smoke-"));
const SUCCESS = "persistence: enabled"; // cli logs this only after the DB layer loads + migrates
const TIMEOUT_MS = 20_000;

const child = spawn(process.execPath, ["--experimental-sqlite", "dist/cli.js"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    DB_PATH: join(dir, "smoke.db"),
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    BOOTSTRAP_DOMAIN: "smoke.test",
    // High, unlikely-to-conflict ports (PORT=0 would fall back to 3000 via `|| default`).
    PORT: "39080",
    ADMIN_PORT: "39081",
    ADMIN_BIND: "127.0.0.1",
  },
});

let out = "";
let settled = false;
const finish = (ok, msg) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  // Best-effort cleanup: on Windows the just-killed child may still hold the SQLite
  // file handle briefly, so retry and never let a cleanup failure change the result.
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir; OS will reap */ }
  if (ok) {
    console.log("✓ dist smoke: bundled CLI initialized node:sqlite persistence");
    process.exit(0);
  }
  console.error(`✗ dist smoke FAILED: ${msg}\n--- cli output ---\n${out}`);
  process.exit(1);
};

const timer = setTimeout(() => finish(false, "timed out waiting for startup"), TIMEOUT_MS);
const onData = (d) => { out += d.toString(); if (out.includes(SUCCESS)) finish(true); };
child.stdout.on("data", onData);
child.stderr.on("data", onData); // capture errors (e.g. ERR_MODULE_NOT_FOUND)
child.on("exit", (code) => finish(false, `CLI exited before startup (code ${code})`));
child.on("error", (err) => finish(false, `failed to spawn CLI: ${err.message}`));
