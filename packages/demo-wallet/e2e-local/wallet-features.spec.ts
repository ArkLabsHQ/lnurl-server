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

test("boot: lnurl-server down keeps a returning wallet out of onboarding until Retry finds its address", async ({ browser }) => {
  const { context, page, username } = await freshWallet(browser, "down", { keepExisting: true });
  try {
    const listing = (url: URL) => url.href.startsWith(stack.lnurlBase) && url.pathname === "/lnurl/address";
    await page.route(listing, (route) => route.fulfill({ status: 503, body: "down" }));
    await page.reload();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("heading", { name: "Create your wallet" })).toHaveCount(0);

    await page.unroute(listing);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText(`${username}@${stack.lnurlDomain}`)).toBeVisible({ timeout: 120_000 });
    expect(await adminUsernames(GLOBAL_ADMIN, username)).toEqual([username]);
  } finally {
    await context.close();
  }
});

/** Records across every store in the SDK's IndexedDB. Summed rather than named,
 *  so a store added by a later SDK counts without editing this. */
const sdkRecords = (page: Page): Promise<number> =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("arkade-service-worker");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const names = Array.from(db.objectStoreNames);
    const counts = await Promise.all(
      names.map((n) => new Promise<number>((resolve) => {
        const req = db.transaction(n, "readonly").objectStore(n).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      })),
    );
    db.close();
    return counts.reduce((a, b) => a + b, 0);
  });

test("erase empties the SDK store, so the next wallet cannot inherit it", async ({ browser }) => {
  const { context, page } = await freshWallet(browser, "wipe");
  try {
    // Opening a wallet writes its arkd snapshot, so there is something to erase.
    await expect.poll(() => sdkRecords(page), { timeout: 60_000 }).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Erase wallet…" }).click();
    await page.getByPlaceholder("ERASE").fill("ERASE");
    await page.getByRole("button", { name: "Erase wallet", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Create your wallet" })).toBeVisible();

    // The regression: erase cleared localStorage only, leaving the next identity
    // the previous one's VTXOs and unsignable contracts.
    expect(await sdkRecords(page)).toBe(0);

    await onboard(page, "wipe2");
    await expect(page.locator("div").filter({ hasText: /^0 sats$/ }).first())
      .toBeVisible({ timeout: 120_000 });
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

    // Importing is a way of replacing this wallet, not a routine setting, so it
    // sits behind the same confirmation as erasing.
    await second.page.getByRole("button", { name: "Settings" }).click();
    await second.page.getByRole("button", { name: "Erase wallet…" }).click();
    await second.page.getByPlaceholder("ERASE").fill("ERASE");
    await second.page.getByPlaceholder(/twelve words/).fill(phrase!);
    await second.page.getByRole("button", { name: "Erase and import" }).click();

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

    // The same key owns nothing on the other server, so the wallet boots into onboarding there.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Create your wallet" })).toBeVisible({ timeout: 120_000 });
    const moved = await onboard(page, "sy");
    expect(await adminUsernames(OTHER_ADMIN, moved)).toEqual([moved]);
    expect(await adminUsernames(GLOBAL_ADMIN, moved)).toEqual([]);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText(other.base, { exact: true })).toBeVisible();

    // The override lives beside the keys and must survive wiping them.
    await page.getByRole("button", { name: "Erase wallet…" }).click();
    await page.getByPlaceholder("ERASE").fill("ERASE");
    await page.getByRole("button", { name: "Erase wallet", exact: true }).click();
    const again = await onboard(page, "sz");
    expect(await adminUsernames(OTHER_ADMIN, again)).toEqual([again]);
    expect(await adminUsernames(GLOBAL_ADMIN, again)).toEqual([]);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText(other.base, { exact: true })).toBeVisible();
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
    // One card now: the rails are part of the address, not a panel beside it.
    const card = page.locator("div").filter({ has: page.getByRole("heading", { name: "Your Lightning address" }) }).last();
    for (const rail of ["lightning", "arkade", "onchain"]) {
      await expect(card.getByText(rail, { exact: true })).toBeVisible({ timeout: 60_000 });
    }

    // Above the onchain rail's economic floor (ONCHAIN_MIN_SENDABLE_SATS): dust is
    // what arkd accepts, not what is worth a Bitcoin fee to deliver, so the rail
    // refuses the 1000 the box defaults to.
    await page.getByRole("spinbutton").fill("12000");

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
    const row = page.locator("div").filter({ hasText: /arkade2500 sats/ }).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toContainText("pending");

    await page.reload();
    await page.getByRole("button", { name: "Activity" }).click();
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 120_000 });
    await expect(page.locator("div").filter({ hasText: /arkade2500 sats/ }).first()).toBeVisible();
  });
});
