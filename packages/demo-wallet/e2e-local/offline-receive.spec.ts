// The point of the local stack: a browser wallet receives a REAL Lightning
// payment with nobody in the loop — no node makes mutinynet pay on demand.
import { expect, test } from "@playwright/test";
import { counterpartyPayment, mine, payFromCounterparty, pollUntil } from "../../../test/e2e/support/regtest.js";
import { readLocalStack, useLocalStack } from "./local-stack.js";

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
  await expect(page.getByText(/^tark1/).first()).toBeVisible();
  expect(errors).toEqual([]);

  const balanceBefore = sats(await page.locator("div").filter({ hasText: /^\d+ sats$/ }).first().innerText());

  const payRequest = await (await fetch(`${stack.lnurlBase}/.well-known/lnurlp/${username}`)).json();
  expect(payRequest.tag, `address did not resolve: ${payRequest.reason}`).toBe("payRequest");
  // The advertised callback carries the address's domain, and a LUD-16 domain
  // cannot name a port — so re-origin it rather than teach the server to
  // advertise one it would not advertise behind a proxy.
  const callbackUrl = new URL(new URL(String(payRequest.callback)).pathname, stack.lnurlBase);
  const callback = await (await fetch(`${callbackUrl}?amount=${SATS * 1000}`)).json();
  expect(callback.status, `callback refused: ${callback.reason}`).not.toBe("ERROR");
  const invoice = String(callback.pr);
  expect(invoice, "the offline-swap rail should have minted a regtest hold invoice").toMatch(/^lnbcrt/);
  const verifyUrl = String(callback.verify);
  const paymentHash = verifyUrl.split("/").pop()!;

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
    const payment = await counterpartyPayment(paymentHash);
    expect(payment?.status).toBe("SUCCEEDED");
    expect(payment?.payment_preimage).toBe(preimage);
    expect(Number(payment?.value_sat)).toBe(SATS);
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
  await expect(page.getByRole("heading", { name: `Payments to ${username}` })).toBeVisible({ timeout: 60_000 });
});
