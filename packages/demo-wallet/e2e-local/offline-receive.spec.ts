// The point of the local stack: a browser wallet receives a REAL Lightning
// payment with nobody in the loop — no node makes mutinynet pay on demand.
import { expect, test } from "@playwright/test";
import { counterpartyPayment, mine, payFromCounterparty, pollUntil } from "../../../test/e2e/support/regtest.js";
import { readLocalStack, useLocalStack } from "./local-stack.js";
import { paymentHashFromBolt11 } from "../../../src/bolt11.js";

const SATS = 5000;
const SWAP_TIMEOUT_MS = 12 * 60_000;

const sats = (text: string) => Number(text.trim().split(" ")[0]);

test("a browser wallet claims a name on the local server and receives a Lightning payment", async ({ page }) => {
  test.setTimeout(SWAP_TIMEOUT_MS + 120_000);
  const stack = readLocalStack();
  await useLocalStack(page, stack);

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Onboarding is itself the derivation proof: an Arkade Service refuses a
  // wallet whose coin type disagrees with its network.
  const username = `rt${Date.now().toString(36)}`;
  await page.goto("./");
  await page.getByPlaceholder("username").fill(username);
  await page.getByRole("button", { name: "Create wallet" }).click();

  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(`${username}@${stack.lnurlDomain}`)).toBeVisible();
  // The rails live in the address card now rather than a panel of their own, and
  // are fetched on demand, so the control that fetches them is what proves the
  // receive screen is whole.
  await expect(page.getByRole("button", { name: /Load options/ })).toBeVisible();
  expect(errors).toEqual([]);

  const balanceBefore = sats(await page.locator("div").filter({ hasText: /^\d+ sats$/ }).first().innerText());

  // Requested through the Receive tab, so the page's own verifyBatch stream is what
  // has to report the settlement below. The callback carries the LUD-16 domain,
  // which cannot name a port, so the page's request is re-origined onto the server.
  const portless = `http://${stack.lnurlDomain}/`;
  await page.route((url) => url.href.startsWith(portless), (route) =>
    route.continue({ url: route.request().url().replace(portless, `${stack.lnurlBase}/`) }));
  await page.locator('input[type="number"]').fill(String(SATS));
  await page.getByRole("button", { name: /Load options/ }).click();
  await page.locator("div").filter({ has: page.locator("span", { hasText: /^lightning$/ }) }).last()
    .getByRole("button", { name: `Request ${SATS} sats` }).click();
  const invoice = (await page.getByText(/^lnbcrt/).first().innerText({ timeout: 60_000 })).trim();
  const paymentHash = paymentHashFromBolt11(invoice)!;
  expect(paymentHash, "the offline-swap rail should have minted a regtest hold invoice").toMatch(/^[0-9a-f]{64}$/);
  const verifyUrl = `${stack.lnurlBase}/lnurl/verify/${paymentHash}`;

  const payer = payFromCounterparty(invoice);
  try {
    // Lockup and claim each need a confirmation and the callback hands out no
    // swap id, so mine on a timer, inside the HTLC's 54-block CLTV budget.
    const MAX_BLOCKS = 24;
    let blocks = 0;
    let lastMine = 0;
    let settled: Record<string, unknown> = {};
    await pollUntil(
      "verify settled",
      async () => {
        if (blocks < MAX_BLOCKS && Date.now() - lastMine > 15_000) {
          await mine(1);
          blocks += 1;
          lastMine = Date.now();
        }
        const status = await (await fetch(verifyUrl)).json();
        if (status.settled === true) {
          settled = status;
          return true;
        }
        return false;
      },
      SWAP_TIMEOUT_MS - 60_000,
      3000,
      () => `${blocks} blocks mined, verify still unsettled`,
    );

    // Nothing but a real settlement produces this.
    const preimage = String(settled.preimage);
    expect(preimage).toMatch(/^[0-9a-f]{64}$/);
    // Awaited, not snapshotted: verify settles when THIS server claims, and that
    // claim is what lets the solver settle — so SUCCEEDED lands just after.
    let payment: Awaited<ReturnType<typeof counterpartyPayment>> = null;
    await pollUntil(
      "the payer's Lightning payment to succeed",
      async () => {
        payment = await counterpartyPayment(paymentHash);
        return payment?.status === "SUCCEEDED";
      },
      120_000,
      2000,
    );
    expect(payment!.payment_preimage).toBe(preimage);
    expect(Number(payment!.value_sat)).toBe(SATS);
    await expect(page.getByText("settled", { exact: true })).toBeVisible({ timeout: 60_000 });
  } finally {
    payer.stop();
  }

  // The half only a browser answers: the money is spendable in the wallet.
  await expect
    .poll(async () => {
      await page.getByRole("button", { name: "Refresh" }).click();
      return sats(await page.locator("div").filter({ hasText: /^\d+ sats$/ }).first().innerText());
    }, { timeout: 180_000, intervals: [5_000] })
    .toBeGreaterThan(balanceBefore);

  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 60_000 });
});
