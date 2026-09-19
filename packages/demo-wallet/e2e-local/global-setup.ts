import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARKD_URL, EMULATOR_URL, ensureStack, fundSolverFloat } from "../../../test/e2e/support/regtest.js";
import { registryIndex, solverCard } from "../../../test/fixtures/solver-cards.js";
import {
  CARDS_FILE,
  REGISTRY_FILE,
  HANDOFF,
  LNURL_ADMIN_PORT,
  LNURL_BASE,
  LNURL_DOMAIN,
  LNURL_PORT,
  STATE_DIR,
  startLnurlServer,
  type LocalStack,
} from "./local-stack.js";

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

  const card = solverCard("registry", 30, "regtest");
  writeFileSync(CARDS_FILE, JSON.stringify([card], null, 2));
  // The browser half of the same card: it has no cards file, only a registry URL.
  writeFileSync(REGISTRY_FILE, JSON.stringify(registryIndex(card, Date.now(), "regtest"), null, 2));

  log(`starting lnurl-server on ${LNURL_BASE}…`);
  const server = await startLnurlServer({
    port: LNURL_PORT,
    adminPort: LNURL_ADMIN_PORT,
    dbPath: join(STATE_DIR, "lnurl-server.sqlite"),
    cardsFile: CARDS_FILE,
    logName: "lnurl-server.log",
  });

  writeFileSync(HANDOFF, JSON.stringify(stack, null, 2));
  log("ready");

  // The stack stays up; tearing it down makes every run a first boot.
  return () => server.stop();
}
