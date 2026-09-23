import type { Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARKD_URL, EMULATOR_URL, SOLVER_HTTP_TEST_URL, pollUntil } from "../../../test/e2e/support/regtest.js";
import { ENDPOINTS_KEY } from "../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

/** Not 4173: the mutinynet suite previews there with `reuseExistingServer`. */
export const WALLET_PORT = 4273;
export const LNURL_PORT = 4283;
export const LNURL_ADMIN_PORT = 4284;
export const LNURL_BASE = `http://127.0.0.1:${LNURL_PORT}`;
/** `domainFromHost` drops the port, so this is what the server files the
 *  address under and what the wallet mints its token for. */
export const LNURL_DOMAIN = "127.0.0.1";

/** Same-origin on purpose: the solver sends no CORS headers, so the preview
 *  server proxies `/solver` to it (see `DEMO_WALLET_SOLVER_PROXY`). */
export const SOLVER_PROXY_BASE = `http://127.0.0.1:${WALLET_PORT}/solver`;
/** The stack's card is in no published registry, so the preview server serves
 *  one built from it — otherwise the browser discovers no market at all. */
export const SOLVER_REGISTRY_URL = `http://127.0.0.1:${WALLET_PORT}/solver-registry.json`;

export const STATE_DIR = resolve(HERE, "..", "..", "..", ".e2e-cache", "browser-local");
export const HANDOFF = resolve(STATE_DIR, "stack.json");
/** Written by the global setup; a second server reads the same one. */
export const CARDS_FILE = resolve(STATE_DIR, "solver-cards.json");
/** The same card as a registry index, for the browser. */
export const REGISTRY_FILE = resolve(STATE_DIR, "solver-registry.json");

export interface LocalStack {
  lnurlBase: string;
  lnurlDomain: string;
  arkServer: string;
  network: "regtest";
  emulatorPubkey: string;
}

export interface LnurlServerHandle {
  base: string;
  logPath: string;
  stop: () => Promise<void>;
}

export interface LnurlServerOptions {
  port: number;
  adminPort: number;
  dbPath: string;
  cardsFile: string;
  logName: string;
  /** Merged last: the only thing a differently-wired server states for itself. */
  env?: Record<string, string>;
  /** `src` (default) runs the working tree through tsx. `dist` is only for the
   *  admin SPA: the server serves whatever `admin-ui` sits beside its own
   *  module, and beside the source that is raw TSX no browser can execute. */
  entry?: "src" | "dist";
}

/** Produce `dist/cli.js` + `dist/admin-ui` from the current tree. */
export async function buildDistServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm build:server", { cwd: REPO_ROOT, stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pnpm build:server exited with ${code}`))));
  });
}

/** Start `src/cli.ts` against the running stack and wait for it to be ready. A
 *  second one on another port is how a different configuration is exercised: the
 *  stack is a singleton, so restarting it to flip a flag re-boots everything. */
export async function startLnurlServer(opts: LnurlServerOptions): Promise<LnurlServerHandle> {
  const base = `http://127.0.0.1:${opts.port}`;
  const logPath = join(STATE_DIR, opts.logName);
  const argv = opts.entry === "dist"
    ? ["--experimental-sqlite", "--experimental-eventsource", "dist/cli.js"]
    : ["--import", "tsx", "--experimental-sqlite", "--experimental-eventsource", "src/cli.ts"];
  const child = spawn(
    process.execPath,
    argv,
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(opts.port),
        ADMIN_PORT: String(opts.adminPort),
        BASE_URL: base,
        BOOTSTRAP_DOMAIN: LNURL_DOMAIN,
        DB_PATH: opts.dbPath,
        ALLOW_INSECURE_TOKEN_STORAGE: "1",
        TRUST_PROXY: "false",
        SOLVER_CARDS_FILE: opts.cardsFile,
        // The stack's solver runs `serve`; its card's relay is a fiction here.
        SOLVER_RFQ_HTTP_URL: SOLVER_HTTP_TEST_URL,
        ARK_SERVER_URL: ARKD_URL,
        // No COVCLAIMD_URL: the server pushes the covenant's own claim leaf.
        OFFLINE_SELF_CLAIM: "true",
        OFFLINE_EMULATOR_URL: EMULATOR_URL,
        OFFLINE_POLL_INTERVAL_MS: "2000",
        REGISTRATION_RATE_LIMIT: "1000",
        ...opts.env,
      },
    },
  );
  const sink = createWriteStream(logPath, { flags: "a" });
  child.stdout?.pipe(sink);
  child.stderr?.pipe(sink);
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[lnurl-server:${opts.port}] ${chunk}`));
  let exited: number | null = null;
  child.on("exit", (code) => { exited = code ?? -1; });

  await pollUntil(
    `lnurl-server on ${base}`,
    async () => {
      if (exited !== null) throw new Error(`lnurl-server exited with code ${exited} — see ${logPath}`);
      return fetch(`${base}/livez`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    },
    120_000,
    1000,
  );
  const ready = await fetch(`${base}/readyz`);
  if (!ready.ok) throw new Error(`lnurl-server on ${base} is live but not ready: ${await ready.text()}`);

  return {
    base,
    logPath,
    stop: async () => {
      if (exited !== null) return;
      child.kill();
      for (let i = 0; exited === null && i < 50; i++) await new Promise((r) => setTimeout(r, 100));
      // One that outlives the run still holds its port, and the NEXT run then
      // fails to bind rather than reporting anything about this one.
      if (exited === null) child.kill("SIGKILL");
    },
  };
}

/**
 * Send the page's port-less requests to a server that has a port.
 *
 * The payRequest advertises a callback on the address's own domain, and a LUD-16
 * domain cannot name one — so `127.0.0.1/...` here is what `pay.example.com/...`
 * is in a deployment. This stands in for the port a real one does not need.
 */
export async function forwardPortlessCallbacks(page: Page, port = LNURL_PORT): Promise<void> {
  await page.route(
    (url) => url.hostname === "127.0.0.1" && url.port === "",
    async (route) => {
      const target = new URL(route.request().url());
      target.port = String(port);
      target.protocol = "http:";
      await route.fulfill({ response: await route.fetch({ url: target.toString() }) });
    },
  );
}

/**
 * Ask an address for one of its rails, the way a payer does.
 *
 * The wallet no longer prints an Arkade or boarding address — everything goes
 * through the LN address — so this is how a test learns where to pay. The
 * advertised callback carries the address's domain, and a LUD-16 domain cannot
 * name a port, so it is re-origined onto the server actually serving it.
 */
export async function requestOption(
  base: string,
  username: string,
  sats: number,
  option: string,
): Promise<{ pr?: string; paymentDestination?: string; verify?: string }> {
  const payRequest = await (await fetch(`${base}/.well-known/lnurlp/${username}`)).json();
  if (payRequest.tag !== "payRequest") throw new Error(`address did not resolve: ${payRequest.reason}`);
  const callback = new URL(new URL(String(payRequest.callback)).pathname, base);
  const body = await (await fetch(`${callback}?amount=${sats * 1000}&paymentOption=${option}`)).json();
  if (body.status === "ERROR") throw new Error(`${option} refused: ${body.reason}`);
  return body;
}

/** The boarding address the `onchain` rail hands out — this wallet's funding path. Asked at
 *  the rail's advertised minimum, which the callback enforces like any other bound. */
export async function boardingAddressOf(base: string, username: string): Promise<string> {
  const payRequest = await (await fetch(`${base}/.well-known/lnurlp/${username}`)).json();
  const onchain = (payRequest.paymentOptions ?? []).find((o: { id: string }) => o.id === "onchain");
  const minSat = Math.ceil(Number(onchain?.minSendable ?? payRequest.minSendable) / 1000);
  const { paymentDestination } = await requestOption(base, username, minSat, "onchain");
  if (!paymentDestination) throw new Error("onchain rail returned no destination");
  return paymentDestination;
}

export function readLocalStack(): LocalStack {
  try {
    return JSON.parse(readFileSync(HANDOFF, "utf8")) as LocalStack;
  } catch {
    throw new Error(`${HANDOFF} is missing — run this suite through playwright.local.config.ts, whose global setup writes it`);
  }
}

/** `config.ts` reads the record once at module scope, so this has to be an init
 *  script: setting it after `goto` would take effect a navigation too late.
 *  It runs on every navigation, so the default wipe makes a reload a fresh
 *  browser; `keepExisting` seeds once, leaving a reload under test intact. */
export async function useLocalStack(
  page: Page,
  stack: LocalStack = readLocalStack(),
  opts?: { keepExisting?: boolean },
): Promise<void> {
  const record = JSON.stringify({
    lnurlBase: stack.lnurlBase,
    arkServer: stack.arkServer,
    network: stack.network,
    emulatorPubkey: stack.emulatorPubkey,
    solverRfqHttpUrl: SOLVER_PROXY_BASE,
    solverRegistryUrl: SOLVER_REGISTRY_URL,
  });
  await page.addInitScript(
    ([key, value, keep]) => {
      if (keep) {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
        return;
      }
      localStorage.clear();
      localStorage.setItem(key, value);
    },
    [ENDPOINTS_KEY, record, opts?.keepExisting ?? false] as const,
  );
}
