import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { MnemonicIdentity, Wallet } from "@arkade-os/sdk";
import { ESPLORA_URL, faucet, mine, nodeSqliteStorage, pollUntil } from "../../../test/e2e/support/regtest.js";
import {
  CARDS_FILE,
  STATE_DIR,
  readLocalStack,
  reserveName,
  setModes,
  startLnurlServer,
  useLocalStack,
  type LnurlServerHandle,
  type LocalStack,
} from "./local-stack.js";

const SATS = 3300;

let stack: LocalStack;
let restoreModes: string[] | undefined;

test.beforeAll(async () => {
  stack = readLocalStack();
  restoreModes = await setModes(stack, (modes) => [...new Set([...modes, "admin", "session"])]);
});

test.afterAll(async () => {
  if (restoreModes) await setModes(stack, () => restoreModes!);
});

const freshName = (prefix: string) => `${prefix}${Date.now().toString(36)}`;

async function claimReserved(page: Page, username: string, claimCode: string): Promise<void> {
  await page.getByRole("button", { name: "I have a claim code" }).click({ timeout: 60_000 });
  await page.getByPlaceholder("reserved name").fill(username);
  await page.getByPlaceholder("claim code").fill(claimCode);
  await page.getByRole("button", { name: "Claim reserved name" }).click();
}

test("onboards onto an operator-reserved name with its claim code", async ({ page }) => {
  await useLocalStack(page, stack);
  const username = freshName("cc");
  const claimCode = await reserveName(stack, username);
  await page.goto("./");

  await claimReserved(page, username, claimCode);
  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(`${username}@${stack.lnurlDomain}`)).toBeVisible();
});

test("names a nameless receiver with a claim code", async ({ page }) => {
  await useLocalStack(page, stack);
  await page.goto("./");
  await page.getByRole("button", { name: "Skip — just a LNURL" }).click({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Your LNURL" })).toBeVisible({ timeout: 120_000 });

  const call = page.locator("details", { hasText: "await receiver.upgrade({ username, claimCode })" });
  await call.locator("summary").click({ timeout: 30_000 });
  await expect(call.getByText("await receiver.upgrade({ username, claimCode })")).toBeVisible();

  const username = freshName("up");
  await claimReserved(page, username, await reserveName(stack, username));
  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(`${username}@${stack.lnurlDomain}`)).toBeVisible();
});

// A covenant server: its arkade quotes carry a verify without a solver quote, and the
// solver allows the whole suite only five per window.
test.describe("verifyBatch on the Receive tab", () => {
  let server: LnurlServerHandle;
  let payerWallet: Wallet | undefined;

  test.beforeAll(async () => {
    server = await startLnurlServer({
      port: 4293,
      adminPort: 4294,
      dbPath: join(STATE_DIR, "lnurl-demo-features.sqlite"),
      cardsFile: CARDS_FILE,
      logName: "lnurl-demo-features.log",
      env: { OFFLINE_COVENANT_DESTINATIONS: "true" },
    });
    payerWallet = await fundedPayer(stack.arkServer);
  });

  test.afterAll(async () => {
    await payerWallet?.dispose().catch(() => undefined);
    await server?.stop();
  });

  test("watches two receives on one connection until both settle", async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await useLocalStack(page, { ...stack, lnurlBase: server.base });
    const streams: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/lnurl/verifyBatch") && r.headers()["accept"] === "text/event-stream") streams.push(r.url());
    });
    const portless = `http://${stack.lnurlDomain}/`;
    await page.route((url) => url.href.startsWith(portless), (route) =>
      route.continue({ url: route.request().url().replace(portless, `${server.base}/`) }));

    await page.goto("./");
    await page.getByPlaceholder("username").fill(freshName("two"));
    await page.getByRole("button", { name: "Create wallet" }).click();
    await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible({ timeout: 120_000 });

    await page.locator('input[type="number"]').fill(String(SATS));
    await page.getByRole("button", { name: /Load options/ }).click();
    const request = page.getByRole("button", { name: `Request ${SATS} sats` });
    const requestArkade = () => page.locator("div")
      .filter({ has: page.locator("span", { hasText: /^arkade$/ }) }).filter({ has: request }).last()
      .getByRole("button", { name: `Request ${SATS} sats` }).click({ timeout: 60_000 });
    const payable = () => page.getByText(/^tark1/).first().innerText({ timeout: 60_000 }).then((t) => t.trim());

    await requestArkade();
    const first = await payable();
    await requestArkade();
    await expect.poll(payable, { timeout: 60_000 }).not.toBe(first);
    const second = await payable();

    await expect(page.getByText("watching 2 invoices on one connection")).toBeVisible({ timeout: 30_000 });
    expect(streams).toHaveLength(1);

    for (const address of [first, second]) await payerWallet!.sendBitcoin({ address, amount: SATS });
    await expect(page.getByText("settled", { exact: true })).toHaveCount(2, { timeout: 180_000 });
  });
});

async function fundedPayer(arkServer: string): Promise<Wallet> {
  const wallet = await Wallet.create({
    identity: MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist), { isMainnet: false }),
    arkServerUrl: arkServer,
    esploraUrl: ESPLORA_URL,
    storage: await nodeSqliteStorage(":memory:"),
    settlementConfig: false,
  });
  await faucet(await wallet.getBoardingAddress(), "0.002");
  await mine(1);
  // arkd must see the confirmed deposit before it is a valid settle input.
  await pollUntil("the payer's deposit to settle", () => wallet.settle().then(() => true, (e: Error) => {
    if (!e.message.includes("No inputs found")) throw e;
    return false;
  }), 60_000, 2000);
  await mine(1);
  return wallet;
}
