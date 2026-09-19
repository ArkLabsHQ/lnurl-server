import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MNEMONIC_KEY, USERNAME_KEY } from "../src/config.js";

// A REAL payment between two wallets over the arkade rail, on mutinynet, with
// real funds. Everything up to here proved the rails resolve and quote; this is
// the only thing that proves money moves.
const STORE = resolve(process.cwd(), "../../.e2e-cache/demo-wallet.json");
const AMOUNT = 1000;

const funded = (): { mnemonic: string; username: string } => JSON.parse(readFileSync(STORE, "utf8"));

async function openFunded(page: Page) {
  const saved = funded();
  await page.addInitScript(
    ([mk, m, uk, u]) => { localStorage.setItem(mk, m); localStorage.setItem(uk, u); },
    [MNEMONIC_KEY, saved.mnemonic, USERNAME_KEY, saved.username] as const,
  );
  await page.goto("./");
  await page.getByRole("heading", { name: "Your Lightning address" }).waitFor({ timeout: 120_000 });
}

/** A fresh wallet, onboarded through the UI, returning its LUD-16 address. */
async function newRecipient(page: Page): Promise<string> {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("./");
  const name = `rcv${Date.now().toString(36)}`;
  await page.getByPlaceholder("username").fill(name);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await page.getByRole("heading", { name: "Your Lightning address" }).waitFor({ timeout: 120_000 });
  return `${name}@lnurl.mutinynet.arkade.sh`;
}

// @funded: see ln-latency.spec.ts. The regtest twin is
// e2e-local/send-paths.spec.ts, which pays over the same rail from faucet sats.
test("pays another wallet's lightning address over the arkade rail @funded", async ({ browser }) => {
  test.setTimeout(300_000);

  const recipientPage = await (await browser.newContext()).newPage();
  const recipient = await newRecipient(recipientPage);

  const recipientArk = (await recipientPage.getByText(/^tark1/).first().innerText()).trim();
  console.log("TRIAGE recipient arkade address: " + recipientArk);

  const payerPage = await (await browser.newContext()).newPage();
  await openFunded(payerPage);

  const balanceBefore = Number((await payerPage.locator("div").filter({ hasText: /^\d+ sats$/ }).first().innerText()).split(" ")[0]);
  expect(balanceBefore).toBeGreaterThan(AMOUNT);

  await payerPage.getByRole("button", { name: "Send" }).click();
  await payerPage.getByPlaceholder(/name@domain/).fill(recipient);
  await payerPage.locator('input[type="number"]').fill(String(AMOUNT));
  await payerPage.getByRole("button", { name: "Find routes" }).click();

  // The recipient bound an Arkade identity at onboarding, so the arkade rail
  // must be offered and must outrank lightning.
  await expect(payerPage.getByText("lnurl-arkade")).toBeVisible();

  await payerPage.getByRole("button", { name: `Pay ${AMOUNT} sats` }).first().click();
  await expect(payerPage.getByText(/sent \d+ sats via lnurl-arkade|lnurl-arkade · /)).toBeVisible({ timeout: 120_000 });

  // Money actually left: the payer's spendable balance drops by at least the
  // amount. Asserted on the wallet's own balance, not on our own status text.
  await expect
    .poll(async () => Number((await payerPage.locator("div").filter({ hasText: /^\d+ sats$/ }).first().innerText()).split(" ")[0]),
      { timeout: 120_000, intervals: [3_000] })
    .toBeLessThanOrEqual(balanceBefore - AMOUNT);

  // The half that actually matters. A debit on the payer proves money left;
  // only this proves it arrived, and on the arkade rail it arrives as a VTXO at
  // the recipient's own address with no server in the payment path.
  await expect
    .poll(async () => {
      await recipientPage.getByRole("button", { name: "Refresh" }).click();
      const text = await recipientPage.locator("div").filter({ hasText: /^\d+ sats$/ }).first().innerText();
      return Number(text.split(" ")[0]);
    }, { timeout: 180_000, intervals: [5_000] })
    .toBeGreaterThanOrEqual(AMOUNT);

  // The payment was routed through the recipient's LNURL callback, so the
  // server minted the destination and holds a record for it. If the watcher and
  // syncPayments work, it shows up in the recipient's own activity without the
  // recipient ever having been online for it.
  await recipientPage.getByRole("button", { name: "Activity" }).click();
  await expect
    .poll(async () => recipientPage.getByRole("heading", { name: /Payments to/ }).count(), { timeout: 120_000, intervals: [5_000] })
    .toBeGreaterThan(0);
  const activity = await recipientPage.locator("div").filter({ hasText: /Payments to/ }).first().innerText();
  console.log("RECIPIENT ACTIVITY: " + activity.replace(/\n/g, " | "));

  await recipientPage.close();
  await payerPage.close();
});
