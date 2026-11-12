import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MNEMONIC_KEY, USERNAME_KEY, LNURL_DOMAIN } from "../src/config.js";

// A full Lightning round trip paid from our own funds: one wallet asks the
// server for an offline-receive hold invoice, the other pays that BOLT11 over
// swap's lightning rail, and we time how long settlement takes.
//
// The invoice only settles once something claims the solver's lockup, so the
// number this prints IS the claim latency. It is the measurement the 15s
// settlement poller dominates.
const STORE = resolve(process.cwd(), "../../.e2e-cache/demo-wallet.json");
const SATS = 1100;

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

async function newRecipient(page: Page): Promise<string> {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("./");
  const name = `ln${Date.now().toString(36)}`;
  await page.getByPlaceholder("username").fill(name);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await page.getByRole("heading", { name: "Your Lightning address" }).waitFor({ timeout: 120_000 });
  return name;
}

// @funded: needs the wallet `provision.spec.ts` mints and a human tops up with
// real mutinynet sats, so CI skips it. The same path runs against regtest in
// e2e-local/offline-receive.spec.ts, funded from a faucet.
test("pays an offline-receive invoice over Lightning and times the claim @funded", async ({ browser }) => {
  test.setTimeout(600_000);

  const recipientPage = await (await browser.newContext()).newPage();
  const recipient = await newRecipient(recipientPage);

  // A real hold invoice from the offline-swap rail: the solver mints it and
  // funds a lockup once it is paid.
  const pr = await (await fetch(`https://${LNURL_DOMAIN}/.well-known/lnurlp/${recipient}`)).json();
  const cb = await (await fetch(`${pr.callback}?amount=${SATS * 1000}`)).json();
  expect(cb.status, `callback refused: ${cb.reason}`).not.toBe("ERROR");
  expect(cb.pr, "expected a BOLT11 from the offline-swap rail").toBeTruthy();
  expect(cb.verify).toBeTruthy();

  const payerPage = await (await browser.newContext()).newPage();
  await openFunded(payerPage);
  await payerPage.getByRole("button", { name: "Send" }).click();
  await payerPage.getByPlaceholder(/name@domain/).fill(cb.pr);
  // The invoice fixes its own amount and the lightning rail refuses a request
  // that restates it differently, so the box has to agree with the BOLT11.
  await payerPage.locator('input[type="number"]').fill(String(SATS));
  await payerPage.getByRole("button", { name: "Find routes" }).click();

  // A bare BOLT11 is not an LNURL target, so the lnurl rails must not match it;
  // the solver corridor is what can pay it.
  await expect(payerPage.getByText("lightning", { exact: true }), "no lightning route for the invoice").toBeVisible({ timeout: 60_000 });

  payerPage.on("console", (m) => console.log(`[c.${m.type()}] ${m.text().slice(0, 240)}`));
  payerPage.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 240)}`));
  await payerPage.getByRole("button", { name: "Quote" }).first().click();
  const confirm = payerPage.getByRole("button", { name: /^Pay \d+ sats$/ });
  await confirm.waitFor({ timeout: 120_000 });
  const paidAt = Date.now();
  await confirm.click();

  // Whatever the send box ends up saying is the first thing worth knowing.
  await payerPage.waitForTimeout(45_000);
  const status = await payerPage.locator("div").filter({ hasText: /^(sent|paid|payment failed|routing failed|lightning)/ }).allInnerTexts();
  console.log("PAYER STATUS: " + JSON.stringify(status).slice(0, 400));

  let settledMs: number | undefined;
  for (let i = 0; i < 300; i++) {
    const v = await (await fetch(cb.verify)).json();
    if (v.settled) { settledMs = Date.now() - paidAt; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`CLAIM LATENCY: ${settledMs === undefined ? "NOT SETTLED within 300s" : (settledMs / 1000).toFixed(1) + "s"}`);
  expect(settledMs, "invoice never settled").toBeDefined();

  await recipientPage.close();
  await payerPage.close();
});
