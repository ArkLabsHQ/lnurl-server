// Wallet to wallet, in two browsers, over the two rails that need no Lightning
// node: the recipient's LNURL (lnurl-arkade) and their bare Arkade address (ark).
// Covenant destinations on the recipient's server are what give the payer a verify.
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { bech32, hex } from "@scure/base";
import { ArkAddress, RestIndexerProvider } from "@arkade-os/sdk";
import { faucet, mine } from "../../../test/e2e/support/regtest.js";
import {
  CARDS_FILE,
  STATE_DIR,
  WALLET_PORT,
  readLocalStack,
  startLnurlServer,
  useLocalStack,
  type LnurlServerHandle,
  type LocalStack,
} from "./local-stack.js";

const COVENANT_PORT = 4291;
const COVENANT_ADMIN_PORT = 4292;
const WALLET_BASE = `http://127.0.0.1:${WALLET_PORT}`;
const LNURL_SATS = 2000;
const ARK_SATS = 1500;
const SETTLE_TIMEOUT_MS = 4 * 60_000;

let stack: LocalStack;
let covenant: LnurlServerHandle;
let recipient: { page: Page; username: string; arkadeAddress: string };
let payer: Page;

const sats = (text: string) => Number(text.trim().split(" ")[0]);
const balance = (page: Page) =>
  page.locator("div").filter({ hasText: /^\d+ sats$/ }).first().innerText().then(sats);

/** The wallet is funded by the time either test reads this, so a 0 is a refresh
 *  rendering mid-fetch — and taken as the baseline it makes the drop assertion
 *  unsatisfiable rather than failing on what actually went wrong. */
async function fundedBalance(page: Page, atLeast: number): Promise<number> {
  await expect.poll(() => balance(page), { timeout: 120_000, intervals: [1_000] }).toBeGreaterThan(atLeast);
  return balance(page);
}

const name = (prefix: string) => `${prefix}${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

/** Arrival is asserted here, not on the recipient's balance: a fresh browser
 *  wallet does not surface a transfer it did not make itself. */
async function spendableAt(arkadeAddress: string): Promise<number[]> {
  const script = hex.encode(ArkAddress.decode(arkadeAddress).pkScript);
  const { vtxos } = await new RestIndexerProvider(stack.arkServer).getVtxos({ scripts: [script], spendableOnly: true });
  return vtxos.map((v) => v.value);
}

async function onboard(page: Page, prefix: string): Promise<string> {
  const username = name(prefix);
  await page.goto("./");
  await page.getByPlaceholder("username").fill(username);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible({ timeout: 120_000 });
  return username;
}

/** A LUD-16 domain cannot carry a port, so `user@127.0.0.1` is unresolvable
 *  here and the advertised callback points at :80 — hence an LNURL above, which
 *  carries its own URL, and this standing in for the port a deployment has. */
async function forwardPortlessCallbacks(page: Page, port: number): Promise<void> {
  await page.route(
    (url) => url.hostname === "127.0.0.1" && url.port === "",
    async (route) => {
      const target = new URL(route.request().url());
      target.port = String(port);
      await route.fulfill({ response: await route.fetch({ url: target.toString() }) });
    },
  );
}

async function payOver(page: Page, railId: string, target: string, amount: number): Promise<void> {
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByPlaceholder(/name@domain/).fill(target);
  await page.locator('input[type="number"]').fill(String(amount));
  await page.getByRole("button", { name: "Find routes" }).click();
  const option = page.locator("div").filter({ hasText: new RegExp(`^${railId}Pay `) }).first();
  await expect(option, `${railId} offered no route`).toBeVisible({ timeout: 120_000 });
  await option.getByRole("button", { name: `Pay ${amount} sats` }).click();
}

/** Accumulated, not sampled: the send path writes one status line that the rail
 *  subscription and the verify poll both overwrite, so a match can be transient. */
async function statusReaches(page: Page, pattern: RegExp, timeoutMs: number): Promise<void> {
  const seen: string[] = [];
  const status = page.locator('p[style*="ui-monospace"]').last();
  await expect
    .poll(async () => {
      const text = await status.innerText().catch(() => "");
      if (text && seen.at(-1) !== text) seen.push(text);
      return seen.join(" | ");
    }, { timeout: timeoutMs, intervals: [1000] })
    .toMatch(pattern);
}

async function fund(page: Page): Promise<void> {
  const boardingAddress = (await page.getByText(/^bcrt1/).first().innerText()).trim();
  await faucet(boardingAddress, "0.001");
  await mine(1);
  await expect
    .poll(async () => {
      await page.getByRole("button", { name: "Refresh" }).click();
      return balance(page);
    }, { timeout: 300_000, intervals: [5_000] })
    .toBeGreaterThan(LNURL_SATS + ARK_SATS);
}

test.beforeAll(async ({ browser }) => {
  stack = readLocalStack();
  covenant = await startLnurlServer({
    port: COVENANT_PORT,
    adminPort: COVENANT_ADMIN_PORT,
    dbPath: join(STATE_DIR, "lnurl-send-paths.sqlite"),
    cardsFile: CARDS_FILE,
    logName: "lnurl-send-paths.log",
    env: { OFFLINE_COVENANT_DESTINATIONS: "true" },
  });

  const recipientPage = await (await browser.newContext({ baseURL: WALLET_BASE })).newPage();
  await useLocalStack(recipientPage, { ...stack, lnurlBase: covenant.base });
  const username = await onboard(recipientPage, "rcv");
  recipient = {
    page: recipientPage,
    username,
    arkadeAddress: (await recipientPage.getByText(/^tark1/).first().innerText()).trim(),
  };

  payer = await (await browser.newContext({ baseURL: WALLET_BASE })).newPage();
  await useLocalStack(payer, stack);
  await forwardPortlessCallbacks(payer, COVENANT_PORT);
  await onboard(payer, "pay");
  await fund(payer);
});

test.afterAll(async () => {
  await recipient?.page.context().close();
  await payer?.context().close();
  await covenant?.stop();
});

test("lnurl-arkade: one wallet pays another's LNURL and the receiver confirms it", async () => {
  const url = `${covenant.base}/.well-known/lnurlp/${recipient.username}`;
  const lnurl = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 1023);
  const payerBefore = await fundedBalance(payer, LNURL_SATS);

  await payOver(payer, "lnurl-arkade", lnurl, LNURL_SATS);
  await statusReaches(payer, /sent \d+ sats via lnurl-arkade|lnurl-arkade · /, 180_000);

  await expect.poll(() => balance(payer), { timeout: 120_000, intervals: [3_000] })
    .toBeLessThanOrEqual(payerBefore - LNURL_SATS);

  // Read first: the status line is one slot every rail update overwrites.
  await statusReaches(payer, /receiver confirmed settled via lnurl-arkade/, SETTLE_TIMEOUT_MS);

  // The covenant destination is not the recipient's address; only the sweep puts
  // the money where they can spend it.
  await expect.poll(() => spendableAt(recipient.arkadeAddress), { timeout: SETTLE_TIMEOUT_MS, intervals: [3_000] })
    .toContain(LNURL_SATS);

  // The receiver's own view of it, which is the server's record and not a balance.
  await recipient.page.getByRole("button", { name: "Activity" }).click();
  const activity = recipient.page.locator("div")
    .filter({ has: recipient.page.getByRole("heading", { name: `Payments to ${recipient.username}` }) })
    .last();
  await expect(activity).toContainText(`${LNURL_SATS} sats`, { timeout: 60_000 });
  await expect(activity).toContainText("settled");
});

test("ark: a bare tark1 address pasted into the send box pays it directly", async () => {
  const payerBefore = await fundedBalance(payer, ARK_SATS);

  await payOver(payer, "ark", recipient.arkadeAddress, ARK_SATS);
  await statusReaches(payer, /sent \d+ sats via ark|^ark · /, 180_000);

  await expect.poll(() => balance(payer), { timeout: 120_000, intervals: [3_000] })
    .toBeLessThanOrEqual(payerBefore - ARK_SATS);

  // No server in this path at all, so the indexer is the only witness there is.
  await expect.poll(() => spendableAt(recipient.arkadeAddress), { timeout: SETTLE_TIMEOUT_MS, intervals: [3_000] })
    .toContain(ARK_SATS);
});
