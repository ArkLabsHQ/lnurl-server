import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const app = resolve(process.argv[2] ?? "result");
const profile = JSON.parse(readFileSync(process.argv[3] ?? new URL("../nix/profile.json", import.meta.url), "utf8"));
const port = Number(profile.PORT);
assert.equal(profile.PUBLIC_BIND, "127.0.0.1");
const probe = createServer();
probe.listen(port, "127.0.0.1");
await once(probe, "listening");
await new Promise((done) => probe.close(done));

const child = spawn(join(app, "bin/lnurl-enclave"), [], {
  cwd: "/tmp",
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    NODE_OPTIONS: "--import=data:text/javascript,process.exit(77)",
    LD_PRELOAD: "/nonexistent-lnurl-test.so",
    BASH_ENV: "/nonexistent-lnurl-test.sh",
    DB_PATH: "/nonexistent-lnurl-test/state.sqlite",
    PORT: "1",
    PUBLIC_BIND: "0.0.0.0",
  },
});
let output = "";
child.stdout.on("data", (data) => { output += data; });
child.stderr.on("data", (data) => { output += data; });
const exited = once(child, "exit");
const abort = new AbortController();
try {
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    assert.equal(child.exitCode, null, `packaged process exited: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) });
      ready = response.ok && (await response.json()).status === "ready";
    } catch {}
    if (!ready) await delay(100);
  }
  assert.ok(ready, `packaged process did not become ready: ${output}`);
  const listeners = ["tcp", "tcp6"].flatMap((name) => readFileSync(`/proc/${child.pid}/net/${name}`, "utf8").trim().split("\n").slice(1))
    .map((line) => line.trim().split(/\s+/)).filter((fields) => fields[3] === "0A" && Number.parseInt(fields[1].split(":")[1], 16) === port);
  assert.equal(listeners.length, 1, "expected one loopback listener");
  assert.equal(listeners[0][1].split(":")[0], "0100007F");
  const response = await fetch(`http://127.0.0.1:${port}/lnurl/session`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: abort.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  let event = "";
  const timeout = setTimeout(() => abort.abort(), 5_000);
  try {
    while (!event.includes("\n\n")) {
      const { value, done } = await reader.read();
      assert.ok(!done, "SSE closed before its first event");
      event += new TextDecoder().decode(value);
    }
    assert.match(event, /event: session_created/);
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
  }
  assert.ok(readFileSync(join(app, "lib/lnurl/dist/admin-ui/index.html")).length > 0);
} finally {
  abort.abort();
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}
assert.equal(child.exitCode, 0, output);
execFileSync(process.execPath, [new URL("./smoke-dist.mjs", import.meta.url).pathname], { cwd: join(app, "lib/lnurl"), stdio: "inherit" });
console.log("Packaged launch, environment isolation, loopback HTTP, SSE, admin assets and SQLite smoke passed.");
