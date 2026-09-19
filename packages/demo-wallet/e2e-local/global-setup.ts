import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARKD_URL,
  EMULATOR_URL,
  SOLVER_HTTP_TEST_URL,
  ensureStack,
  fundSolverFloat,
  pollUntil,
} from "../../../test/e2e/support/regtest.js";
import { solverCard } from "../../../test/fixtures/solver-cards.js";
import { HANDOFF, LNURL_ADMIN_PORT, LNURL_BASE, LNURL_DOMAIN, LNURL_PORT, STATE_DIR, type LocalStack } from "./local-stack.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const log = (message: string) => console.log(`[local-stack] ${message}`);

/** The live key, not the SDK's pinned regtest one: a stack raised with another
 *  EMULATOR_SECRET_KEY would fail at claim time rather than here. */
async function emulatorPubkey(): Promise<string> {
  const res = await fetch(`${EMULATOR_URL}/v1/info`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${EMULATOR_URL}/v1/info -> HTTP ${res.status}`);
  const signer = String((await res.json() as { signerPubkey?: unknown }).signerPubkey ?? "");
  if (!/^0[23][0-9a-f]{64}$/i.test(signer)) throw new Error(`emulator reported no usable signerPubkey (${signer || "empty"})`);
  return signer.toLowerCase();
}

function startServer(cardsFile: string, dbPath: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--experimental-sqlite", "--experimental-eventsource", "src/cli.ts"],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(LNURL_PORT),
        ADMIN_PORT: String(LNURL_ADMIN_PORT),
        BASE_URL: LNURL_BASE,
        BOOTSTRAP_DOMAIN: LNURL_DOMAIN,
        DB_PATH: dbPath,
        ALLOW_INSECURE_TOKEN_STORAGE: "1",
        TRUST_PROXY: "false",
        SOLVER_CARDS_FILE: cardsFile,
        // The stack's solver runs `serve`; its card's relay is a fiction here.
        SOLVER_RFQ_HTTP_URL: SOLVER_HTTP_TEST_URL,
        ARK_SERVER_URL: ARKD_URL,
        // No COVCLAIMD_URL: the server pushes the covenant's own claim leaf.
        OFFLINE_SELF_CLAIM: "true",
        OFFLINE_EMULATOR_URL: EMULATOR_URL,
        OFFLINE_POLL_INTERVAL_MS: "2000",
        REGISTRATION_RATE_LIMIT: "1000",
      },
    },
  );
  const sink = createWriteStream(join(STATE_DIR, "lnurl-server.log"), { flags: "a" });
  child.stdout?.pipe(sink);
  child.stderr?.pipe(sink);
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[lnurl-server] ${chunk}`));
  return child;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });

  log("ensuring the regtest stack (first boot pulls ~20 images and can take many minutes)…");
  await ensureStack(log);
  log("funding the solver float…");
  await fundSolverFloat(log);

  const stack: LocalStack = {
    lnurlBase: LNURL_BASE,
    lnurlDomain: LNURL_DOMAIN,
    arkServer: ARKD_URL,
    network: "regtest",
    emulatorPubkey: await emulatorPubkey(),
  };
  log(`emulator signer ${stack.emulatorPubkey}`);

  const cardsFile = join(STATE_DIR, "solver-cards.json");
  writeFileSync(cardsFile, JSON.stringify([solverCard("registry", 30, "regtest")], null, 2));

  log(`starting lnurl-server on ${LNURL_BASE}…`);
  const server = startServer(cardsFile, join(STATE_DIR, "lnurl-server.sqlite"));
  let exited: number | null = null;
  server.on("exit", (code) => { exited = code ?? -1; });

  await pollUntil(
    "lnurl-server",
    async () => {
      if (exited !== null) throw new Error(`lnurl-server exited with code ${exited} — see ${join(STATE_DIR, "lnurl-server.log")}`);
      return fetch(`${LNURL_BASE}/livez`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    },
    120_000,
    1000,
  );
  const ready = await fetch(`${LNURL_BASE}/readyz`);
  if (!ready.ok) throw new Error(`lnurl-server is live but not ready: ${await ready.text()}`);

  writeFileSync(HANDOFF, JSON.stringify(stack, null, 2));
  log("ready");

  // The stack stays up; tearing it down makes every run a first boot.
  return async () => {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
  };
}
