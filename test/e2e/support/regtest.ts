// E2E support: the arkade-regtest stack (submodule at repo root) + the corridor's
// external parties, driven by shelling out — the stack's own way of reaching
// something that is not the service under test.
//
// The corridor's stack needs seconds-typed arkd timelocks (arkade-regtest's defaults
// are block-typed); the overrides below are the intent-solver runbook's regtest set.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
export const REGTEST_DIR = join(HERE, "..", "..", "..", "regtest");
export const ARKD_URL = process.env.E2E_ARKD_URL ?? "http://localhost:7070";
export const COVCLAIMD_URL = process.env.E2E_COVCLAIMD_URL ?? "http://localhost:7271";
export const SOLVER_URL = process.env.E2E_SOLVER_URL ?? "http://localhost:8787";
export const ESPLORA_URL = process.env.E2E_ESPLORA_URL ?? "http://localhost:3000/api";

/** The solver's throwaway regtest mnemonic — arkade-regtest's fixed, public, never-real-funds value. */
export const SOLVER_MNEMONIC = "planet travel grab found idle ripple acoustic hero normal mixed rich lamp";

const INTENT_SOLVER_IMAGE = process.env.E2E_INTENT_SOLVER_IMAGE ?? "intent-solver:e2e";
const COVCLAIMD_IMAGE = process.env.E2E_COVCLAIMD_IMAGE ?? "ghcr.io/arkade-os/covclaimd:v0.0.1-rc.4";
const INTENT_SOLVER_REPO = "https://github.com/arkade-os/intent-solver";
const BUILD_CACHE = join(HERE, "..", "..", "..", ".e2e-cache");

const STACK_ENV = {
  ...process.env,
  // seconds, not blocks — a bare `start` produces a stack the corridor cannot use.
  ARKD_VTXO_TREE_EXPIRY: "6144",
  ARKD_UNILATERAL_EXIT_DELAY: "512",
  ARKD_PUBLIC_UNILATERAL_EXIT_DELAY: "512",
  ARKD_BOARDING_EXIT_DELAY: "2048",
  ARKD_CHECKPOINT_EXIT_DELAY: "1536",
  INTENT_SOLVER_IMAGE,
  COVCLAIMD_IMAGE,
  INTENT_SOLVER_MNEMONIC: SOLVER_MNEMONIC, // the compose file interpolates it, and .env.defaults is regtest.mjs-only
  AUTOMINE_INTERVAL: "0", // deterministic: mine only explicitly
};

async function httpOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function pollUntil(what: string, fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`${what} not ready within ${Math.round(timeoutMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** True when the corridor's four services all answer on their host ports. */
export async function stackIsUp(): Promise<boolean> {
  const checks = await Promise.all([
    httpOk(`${ARKD_URL}/v1/info`),
    httpOk(`${COVCLAIMD_URL}/v1/preimage/covclaimd-pubkey`),
    httpOk(`${SOLVER_URL}/healthz`),
    (async () => {
      try {
        const info = await lncli<{ synced_to_chain: boolean }>("lnd", ["getinfo"]);
        return info.synced_to_chain;
      } catch {
        return false;
      }
    })(),
  ]);
  return checks.every(Boolean);
}

/** Build the intent-solver image from upstream master if it's not in the local docker. */
export async function ensureIntentSolverImage(log: (s: string) => void = console.log): Promise<void> {
  const probe = await run("docker", ["image", "inspect", INTENT_SOLVER_IMAGE]).catch(() => null);
  if (probe) return;
  log(`building ${INTENT_SOLVER_IMAGE} from ${INTENT_SOLVER_REPO} (one-time, several minutes)...`);
  const dir = join(BUILD_CACHE, "intent-solver");
  if (!existsSync(join(dir, "packages"))) {
    await run("git", ["clone", "--depth", "1", INTENT_SOLVER_REPO, dir], { timeout: 300_000 });
  }
  // Upstream's createServices deliberately leaves the covclaimd client unset
  // (written before rc.4 was live-verified) — apply the wiring patch, then build.
  // Drop this once the patch (or equivalent) ships upstream.
  await run("git", ["apply", join(HERE, "..", "intent-solver-covclaimd.patch")], { cwd: dir, timeout: 30_000 });
  await run("docker", ["build", "-f", "packages/solver-app/Dockerfile", "-t", INTENT_SOLVER_IMAGE, "."], {
    cwd: dir,
    timeout: 1_800_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Bring the corridor stack up (idempotent; reuses a healthy stack). Long on first boot. */
export async function ensureStack(log: (s: string) => void = console.log): Promise<void> {
  if (!existsSync(join(REGTEST_DIR, "regtest.mjs"))) {
    throw new Error("arkade-regtest submodule missing — run: git submodule update --init");
  }
  await ensureIntentSolverImage(log);
  if (await stackIsUp()) {
    // A running stack may carry a solver from before the current image/overlay —
    // refresh it, then reuse the stack.
    await applySolverOverlay();
    log("regtest stack already healthy; reusing it");
    return;
  }
  log("starting arkade-regtest stack (first boot pulls ~20 images; several minutes)...");
  const child: ChildProcess = spawn("node", ["regtest.mjs", "start"], { cwd: REGTEST_DIR, env: STACK_ENV, stdio: "inherit" });
  await pollUntil(
    "regtest stack",
    async () => {
      if (child.exitCode !== null) throw new Error(`regtest start exited with code ${child.exitCode}`);
      return stackIsUp();
    },
    1_200_000,
    5000,
  );
  await pollUntil("covclaimd", () => httpOk(`${COVCLAIMD_URL}/v1/preimage/covclaimd-pubkey`), 120_000);
  // The stack's intent-solver lacks COVCLAIMD_URL in its env map; the overlay adds it.
  await applySolverOverlay();
}

// -- miner + faucet --

export const mine = (n: number) => run("node", ["regtest.mjs", "mine", String(n)], { cwd: REGTEST_DIR, timeout: 60_000 });
export const faucet = (address: string, amountBtc: string) =>
  run("node", ["regtest.mjs", "faucet", address, amountBtc, "--confirm"], { cwd: REGTEST_DIR, timeout: 60_000 });

// -- the counterparty LND (the corridor's real payer) --

// The intent-solver's LN backend is the base `lnd` container (compose: LND_SOCKET=lnd),
// so solver hold invoices live on `lnd` and the PAYER is the other node, `boltz-lnd`
// (the boltz profile opened and balanced the channel between them). Paying from
// `lnd` fails as a self-payment.
const PAYER_CONTAINER = process.env.E2E_LN_PAYER_CONTAINER ?? "boltz-lnd";

export const lncli = async <T>(container: string, args: readonly string[]): Promise<T> => {
  const { stdout } = await run("docker", ["exec", container, "lncli", "--network=regtest", ...args], { timeout: 30_000 });
  return JSON.parse(stdout) as T;
};

export interface PaymentView {
  payment_hash: string;
  status: "IN_FLIGHT" | "SUCCEEDED" | "FAILED" | "INITIATED";
  payment_preimage: string;
  value_sat: string;
}

/** Start paying `invoice` from the counterparty node; return immediately (hold invoices block by design). */
export function payFromCounterparty(invoice: string, timeoutSeconds = 600): { stop: () => void } {
  const child = spawn("docker", ["exec", PAYER_CONTAINER, "lncli", "--network=regtest", "payinvoice", "--force", "--timeout", `${timeoutSeconds}s`, invoice], {
    stdio: "ignore",
  });
  child.unref();
  child.on("error", () => {});
  return { stop: () => { if (!child.killed) child.kill(); } };
}

/** The payer's own record of the payment, or null if it never saw one. */
export async function counterpartyPayment(paymentHash: string): Promise<PaymentView | null> {
  const listed = await lncli<{ payments: PaymentView[] }>(PAYER_CONTAINER, ["listpayments", "--include_incomplete", "--max_payments", "200"]);
  return listed.payments.find((p) => p.payment_hash === paymentHash) ?? null;
}

// -- the solver's Arkade float --

/** The SDK's SQLExecutor over node:sqlite — driver-agnostic persistence without a native dep. */
export async function nodeSqliteStorage(path: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const { SQLiteWalletRepository, SQLiteContractRepository } = await import("@arkade-os/sdk/repositories/sqlite");
  const db = new DatabaseSync(path);
  const executor = {
    run: (sql: string, params?: unknown[]) => {
      db.prepare(sql).run(...(params ?? []).map((p) => (p === undefined ? null : p)) as never);
    },
    get: <T>(sql: string, params?: unknown[]) => db.prepare(sql).get(...(params ?? []).map((p) => (p === undefined ? null : p)) as never) as T | undefined,
    all: <T>(sql: string, params?: unknown[]) => db.prepare(sql).all(...(params ?? []).map((p) => (p === undefined ? null : p)) as never) as T[],
  };
  return {
    walletRepository: new SQLiteWalletRepository(executor),
    contractRepository: new SQLiteContractRepository(executor),
  };
}

const E2E_OVERLAY = join(HERE, "..", "compose.e2e.yml");

const compose = (args: string[]) =>
  run(
    "docker",
    [
      "compose",
      "-f", join(REGTEST_DIR, "docker", "compose.base.yml"),
      "-f", join(REGTEST_DIR, "docker", "compose.ark.yml"),
      "-f", E2E_OVERLAY,
      "--profile", "intent-solver",
      ...args,
    ],
    { cwd: REGTEST_DIR, env: STACK_ENV, timeout: 120_000 },
  );

/** Recreate intent-solver with the e2e overlay applied (carries COVCLAIMD_URL). */
export async function applySolverOverlay(): Promise<void> {
  const imageId = (await run("docker", ["image", "inspect", INTENT_SOLVER_IMAGE, "--format", "{{.Id}}"])).stdout.trim();
  const current = await run("docker", ["inspect", "intent-solver", "--format", "{{.Image}} {{json .Config.Env}}"]).then(
    (r) => r.stdout,
    () => "",
  );
  if (current.includes(imageId) && current.includes("COVCLAIMD_URL=")) return; // already applied
  await compose(["up", "-d", "--force-recreate", "--no-deps", "intent-solver"]);
  await pollUntil("intent-solver", () => httpOk(`${SOLVER_URL}/healthz`), 180_000);
}

/**
 * Fund the solver's Arkade wallet (its float is what corridor lockups are funded
 * from). The solver container is stopped while a host-side wallet on the same
 * mnemonic boards, settles, and exits — two wallets on one mnemonic tear each
 * other down when concurrent, so they never overlap. Topping up is harmless.
 */
export async function fundSolverFloat(log: (s: string) => void = console.log): Promise<void> {
  const { MnemonicIdentity, Wallet } = await import("@arkade-os/sdk");
  log("funding the solver's Arkade float (solver paused while its wallet is borrowed)...");
  await compose(["stop", "intent-solver"]);
  try {
    const identity = MnemonicIdentity.fromMnemonic(SOLVER_MNEMONIC, { isMainnet: false });
    // Short-lived single-purpose wallet: no background renewal/settle loops.
    log("  creating the borrowed wallet...");
    const wallet = await Wallet.create({
      identity,
      arkServerUrl: ARKD_URL,
      esploraUrl: ESPLORA_URL,
      storage: await nodeSqliteStorage(":memory:"),
      settlementConfig: false,
    });
    log("  wallet up; boarding address next");
    const boarding = await wallet.getBoardingAddress();
    log("  fauceting boarding address " + boarding.slice(0, 20) + "…");
    await faucet(boarding, "0.002");
    await mine(1);
    log("  settling into a vtxo (arkd round)…");
    // arkd needs a moment to see the confirmed deposit before it accepts it as a
    // settle input — retry only that one race.
    for (let attempt = 1; ; attempt++) {
      try {
        await wallet.settle();
        break;
      } catch (err) {
        if (!String(err instanceof Error ? err.message : err).includes("No inputs found") || attempt >= 15) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await mine(1);
    const balance = await wallet.getBalance();
    await wallet.dispose();
    log(`solver float funded: ${balance.available} sats spendable`);
  } finally {
    await compose(["start", "intent-solver"]);
    await pollUntil("intent-solver", () => httpOk(`${SOLVER_URL}/healthz`), 120_000);
  }
}
