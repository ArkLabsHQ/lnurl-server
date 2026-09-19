// The wallet's own surfaces — the ones that are not a payment: the recovery
// phrase, the endpoint overrides, the receive URI and the activity sync.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { MNEMONIC_KEY, USERNAME_KEY, DEFAULT_LNURL_BASE } from "../src/config.js";
import {
  CARDS_FILE,
  LNURL_ADMIN_PORT,
  STATE_DIR,
  WALLET_PORT,
  forwardPortlessCallbacks,
  readLocalStack,
  startLnurlServer,
  useLocalStack,
  type LnurlServerHandle,
  type LocalStack,
} from "./local-stack.js";

const OTHER_PORT = 4289;
const OTHER_ADMIN_PORT = 4290;
const WALLET_BASE = `http://127.0.0.1:${WALLET_PORT}`;
const GLOBAL_ADMIN = `http://127.0.0.1:${LNURL_ADMIN_PORT}`;
const OTHER_ADMIN = `http://127.0.0.1:${OTHER_ADMIN_PORT}`;
const QUOTE_MSAT = 2_500_000;

let stack: LocalStack;
let other: LnurlServerHandle;

const name = (prefix: string) => `${prefix}${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

const adminUsernames = async (adminBase: string, q: string): Promise<string[]> =>
  ((await (await fetch(`${adminBase}/admin/api/addresses?q=${q}`)).json()) as Array<{ username: string }>)
    .map((a) => a.username);

async function onboard(page: Page, prefix: string): Promise<string> {
  const username = name(prefix);
  await page.getByPlaceholder("username").fill(username);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible({ timeout: 120_000 });
  return username;
}

async function freshWallet(browser: Browser, prefix: string, opts?: { keepExisting?: boolean }) {
  const context = await browser.newContext({ baseURL: WALLET_BASE });
  const page = await context.newPage();
  await useLocalStack(page, stack, opts);
  await page.goto("./");
  const username = await onboard(page, prefix);
  return { context, page, username };
}

test.beforeAll(async () => {
  stack = readLocalStack();
  other = await startLnurlServer({
    port: OTHER_PORT,
    adminPort: OTHER_ADMIN_PORT,
    dbPath: join(STATE_DIR, "lnurl-wallet-features.sqlite"),
    cardsFile: CARDS_FILE,
    logName: "lnurl-wallet-features.log",
  });
});

test.afterAll(async () => {
  await other?.stop();
});

test("backup: the revealed phrase is the stored key, and erasing destroys it", async ({ browser }) => {
  const { context, page } = await freshWallet(browser, "bk");
  try {
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("No phrase stored in this browser yet.")).toHaveCount(0);

    await page.getByRole("button", { name: "Reveal phrase" }).click();
    const stored = await page.evaluate((k) => localStorage.getItem(k), MNEMONIC_KEY);
    expect(stored?.split(" ")).toHaveLength(12);
    await expect(page.getByText(stored!, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Hide" }).click();
    await expect(page.getByText(stored!, { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Erase wallet…" }).click();
    const confirm = page.getByRole("button", { name: "Erase wallet", exact: true });
    await expect(confirm).toBeDisabled();
    await page.getByPlaceholder("ERASE").fill("ERASE");
    await confirm.click();

    await expect(page.getByRole("heading", { name: "Create your wallet" })).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k), MNEMONIC_KEY)).toBeNull();
    expect(await page.evaluate((k) => localStorage.getItem(k), USERNAME_KEY)).toBeNull();
  } finally {
    await context.close();
  }
});

test("restore: adopting another phrase takes over the name that key owns", async ({ browser }) => {
  const first = await freshWallet(browser, "r1");
  const phrase = await first.page.evaluate((k) => localStorage.getItem(k), MNEMONIC_KEY);
  await first.context.close();

  const second = await freshWallet(browser, "r2");
  try {
    await expect(second.page.getByText(`${second.username}@${stack.lnurlDomain}`)).toBeVisible();

    await second.page.getByRole("button", { name: "Settings" }).click();
    await second.page.getByPlaceholder("twelve words separated by spaces").fill(phrase!);
    await second.page.getByRole("button", { name: "Restore wallet" }).click();

    // Nothing re-registers here: the server refuses an existing username even to
    // its owner, so the name can only come back from asking what the key owns.
    await second.page.getByRole("button", { name: "Receive" }).click();
    await expect(second.page.getByText(`${first.username}@${stack.lnurlDomain}`)).toBeVisible({ timeout: 120_000 });
    expect(await second.page.evaluate((k) => localStorage.getItem(k), USERNAME_KEY)).toBe(first.username);
  } finally {
    await second.context.close();
  }
});

test("settings: an endpoint override sends the next registration to the other server", async ({ browser }) => {
  const { context, page, username } = await freshWallet(browser, "sx", { keepExisting: true });
  try {
    expect(await adminUsernames(GLOBAL_ADMIN, username)).toEqual([username]);

    await page.getByRole("button", { name: "Settings" }).click();
    const lnurlField = page.getByPlaceholder(DEFAULT_LNURL_BASE);
    await lnurlField.fill("not a url");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Not a URL: not a url")).toBeVisible();

    await lnurlField.fill(other.base);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved. Reload the page to use it.")).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText(other.base, { exact: true })).toBeVisible();

    // Erase rather than a second browser: the override lives beside the keys and
    // survives wiping them, so this is the one path that onboards against it.
    await page.getByRole("button", { name: "Erase wallet…" }).click();
    await page.getByPlaceholder("ERASE").fill("ERASE");
    await page.getByRole("button", { name: "Erase wallet", exact: true }).click();
    const moved = await onboard(page, "sy");
    expect(await adminUsernames(OTHER_ADMIN, moved)).toEqual([moved]);
    expect(await adminUsernames(GLOBAL_ADMIN, moved)).toEqual([]);
  } finally {
    await context.close();
  }
});

test.describe("a wallet that stays open", () => {
  let context: Awaited<ReturnType<Browser["newContext"]>>;
  let page: Page;
  let username: string;

  test.beforeAll(async ({ browser }) => {
    const fresh = await freshWallet(browser, "wf", { keepExisting: true });
    context = fresh.context;
    page = fresh.page;
    username = fresh.username;
    await forwardPortlessCallbacks(page);
    // Recorded rather than read back: a headless page is not reliably focused,
    // and the real clipboard rejects when it is not. What the button hands the
    // clipboard API is the URI under test either way.
    await page.addInitScript(() => {
      const copies: string[] = [];
      (window as unknown as { __copied: string[] }).__copied = copies;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => { copies.push(text); } },
      });
    });
    await page.reload();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("receive: the QR is the LN address, and each rail is requested from it", async () => {
    await page.getByRole("button", { name: "Receive" }).click();
    const lightningAddress = `${username}@${stack.lnurlDomain}`;

    const copied = async () => {
      await page.getByRole("button", { name: /copy URI/ }).first().click();
      return page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1) ?? "");
    };

    // No Arkade or boarding address anywhere: a payer asks the address instead.
    await expect(page.getByText(/^tark1/)).toHaveCount(0);
    await expect(page.getByText(/^bcrt1/)).toHaveCount(0);
    expect(await copied()).toBe(`lightning:${lightningAddress}`);

    await page.getByRole("button", { name: /Load options/ }).click();
    await expect(page.getByText(/accepts \d+/)).toBeVisible({ timeout: 60_000 });
    const card = page.locator("div").filter({ has: page.getByRole("heading", { name: "What this address accepts" }) }).last();
    for (const rail of ["lightning", "arkade", "onchain"]) {
      await expect(card.getByText(rail, { exact: true })).toBeVisible({ timeout: 60_000 });
    }

    // Requesting one is what mints a destination, which is why listing does not.
    await card.locator("div").filter({ hasText: /^onchain/ }).first()
      .getByRole("button", { name: /Request/ }).click();
    await expect(card.getByText(/onchain — pay this/)).toBeVisible({ timeout: 60_000 });
    await expect(card.getByText(/^bcrt1/).first()).toBeVisible();
    // Nothing here watches Bitcoin, so this rail is honest about having no answer.
    await expect(card.getByText(/no verify on this rail/)).toBeVisible();
  });

  test("activity: a record written while the tab was elsewhere syncs in and survives a reload", async () => {
    const url = `${stack.lnurlBase}/.well-known/lnurlp/${username}/callback?amount=${QUOTE_MSAT}&paymentOption=arkade`;
    const quote = (await (await fetch(url)).json()) as { status?: string; reason?: string };
    expect(quote.status, `arkade quote refused: ${quote.reason}`).toBe("OK");

    await page.getByRole("button", { name: "Activity" }).click();
    const row = page.locator("div").filter({ hasText: /lnurlarkade2500 sats/ }).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toContainText("pending");

    await page.reload();
    await page.getByRole("button", { name: "Activity" }).click();
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 120_000 });
    await expect(page.locator("div").filter({ hasText: /lnurlarkade2500 sats/ }).first()).toBeVisible();
  });
});
