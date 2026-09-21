import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MNEMONIC_KEY, USERNAME_KEY } from "../src/config.js";

/**
 * The three claims made about the wallet, checked where a user meets them.
 *
 * Deliberately clicks Refresh nowhere: the balance assertion is the whole test
 * of whether anything streams. A poll that reports the contract manager's stored
 * view, which is what this replaced, cannot pass it.
 *
 * @funded — spends real mutinynet sats from the wallet provision.spec.ts mints.
 * Point it at the deployed site to check what is actually serving:
 *   E2E_BASE_URL=https://arklabshq.github.io/lnurl-server/ pnpm test:browser
 */
const STORE = resolve(process.cwd(), "../../.e2e-cache/demo-wallet.json");
const DOMAIN = "lnurl.mutinynet.arkade.sh";
const AMOUNT = 1200;

const funded = (): { mnemonic: string; username: string } => JSON.parse(readFileSync(STORE, "utf8"));

const balanceOf = async (page: Page): Promise<number> =>
  Number((await page.locator("div").filter({ hasText: /^\d+ sats$/ }).first().innerText()).split(" ")[0]);

async function openFunded(browser: Browser): Promise<{ page: Page; address: string }> {
  const saved = funded();
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(
    ([mk, m, uk, u]) => { localStorage.setItem(mk, m); localStorage.setItem(uk, u); },
    [MNEMONIC_KEY, saved.mnemonic, USERNAME_KEY, saved.username] as const,
  );
  await page.goto("./");
  await page.getByRole("heading", { name: "Your Lightning address" }).waitFor({ timeout: 120_000 });
  return { page, address: `${saved.username}@${DOMAIN}` };
}

async function newWallet(browser: Browser): Promise<{ page: Page; address: string }> {
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(() => localStorage.clear());
  await page.goto("./");
  const name = `lv${Date.now().toString(36)}`;
  await page.getByPlaceholder("username").fill(name);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await page.getByRole("heading", { name: "Your Lightning address" }).waitFor({ timeout: 120_000 });
  return { page, address: `${name}@${DOMAIN}` };
}

test("a received payment arrives without a refresh, as one activity row @funded", async ({ browser }) => {
  test.setTimeout(900_000);
  const a = await openFunded(browser);
  const b = await newWallet(browser);

  try {
    expect(await balanceOf(b.page), "a fresh wallet starts empty").toBe(0);

    await a.page.getByRole("button", { name: "Send" }).click();
    await a.page.getByPlaceholder(/name@domain/).fill(b.address);
    await a.page.locator('input[type="number"]').fill(String(AMOUNT));
    await a.page.getByRole("button", { name: "Find routes" }).click();
    const row = a.page.locator("div").filter({ hasText: /^lnurl-arkade/ }).first();
    await expect(row, "lnurl-arkade was not offered").toBeVisible({ timeout: 60_000 });
    await row.getByRole("button", { name: /Pay/ }).click();
    await expect(a.page.getByText(/sent \d+ sats via lnurl-arkade|lnurl-arkade · /))
      .toBeVisible({ timeout: 180_000 });

    // The claim under test: B is left alone. No Refresh, no reload.
    const arrived = Date.now();
    await expect
      .poll(async () => balanceOf(b.page), { timeout: 240_000, intervals: [1_000] })
      .toBeGreaterThan(0);
    console.log(`LIVE balance arrived unattended after ${Math.round((Date.now() - arrived) / 1000)}s: ${await balanceOf(b.page)} sats`);

    await b.page.getByRole("button", { name: "Activity" }).click();
    await expect(b.page.getByRole("heading", { name: "Activity" })).toBeVisible();

    // Scoped to the feed throughout: the header carries the balance, which on a
    // wallet whose only money is this payment reads as the same number and is
    // not a row at all. Asserting page-wide called that a duplicate.
    const feed = b.page.locator("div").filter({ has: b.page.getByRole("heading", { name: "Activity" }) }).last();
    await expect(feed.getByText(new RegExp(`\\+${AMOUNT} sats`))).toHaveCount(1, { timeout: 120_000 });
    console.log("LIVE feed: " + (await feed.innerText()).replace(/\n/g, " | "));

    // One row for one payment: the duplicate showed the same money twice.
    await expect(feed.getByText(new RegExp(`^${AMOUNT} sats$`)), "a quote row beside its own payment")
      .toHaveCount(0);

    // A wallet row's content: a link out, and no status to second-guess.
    await expect(feed.getByRole("link", { name: "explorer" })).toHaveCount(1);
    await expect(feed.getByText("settled")).toHaveCount(0);
    await expect(feed.getByText("pending")).toHaveCount(0);

    await feed.getByRole("button", { name: "▸" }).first().click();
    await expect(feed.getByText("txid")).toBeVisible();
    await expect(feed.getByText("rail", { exact: true })).toBeVisible();
    console.log(`LIVE activity: one row, explorer link, expander open`);
  } finally {
    await a.page.close();
    await b.page.close();
  }
});
