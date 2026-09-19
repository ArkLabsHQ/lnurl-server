import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENDPOINTS_KEY } from "../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Not 4173: the mutinynet suite previews there with `reuseExistingServer`. */
export const WALLET_PORT = 4273;
export const LNURL_PORT = 4283;
export const LNURL_ADMIN_PORT = 4284;
export const LNURL_BASE = `http://127.0.0.1:${LNURL_PORT}`;
/** `domainFromHost` drops the port, so this is what the server files the
 *  address under and what the wallet mints its token for. */
export const LNURL_DOMAIN = "127.0.0.1";

export const STATE_DIR = resolve(HERE, "..", "..", "..", ".e2e-cache", "browser-local");
export const HANDOFF = resolve(STATE_DIR, "stack.json");

export interface LocalStack {
  lnurlBase: string;
  lnurlDomain: string;
  arkServer: string;
  network: "regtest";
  emulatorPubkey: string;
}

export function readLocalStack(): LocalStack {
  try {
    return JSON.parse(readFileSync(HANDOFF, "utf8")) as LocalStack;
  } catch {
    throw new Error(`${HANDOFF} is missing — run this suite through playwright.local.config.ts, whose global setup writes it`);
  }
}

/** `config.ts` reads the record once at module scope, so this has to be an init
 *  script: setting it after `goto` would take effect a navigation too late. */
export async function useLocalStack(page: Page, stack: LocalStack = readLocalStack()): Promise<void> {
  const record = JSON.stringify({
    lnurlBase: stack.lnurlBase,
    arkServer: stack.arkServer,
    network: stack.network,
    emulatorPubkey: stack.emulatorPubkey,
  });
  await page.addInitScript(
    ([key, value]) => {
      localStorage.clear();
      localStorage.setItem(key, value);
    },
    [ENDPOINTS_KEY, record] as const,
  );
}
