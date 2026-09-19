// The send half over the solver's lightning corridor. Two things had to be true
// before a browser could do this at all on regtest: the stack's solver is in no
// published registry (so the preview server serves one built from its card), and
// it answers HTTP without ever subscribing to a relay (so the RFQ goes over
// `httpTransport`, same-origin through the proxy, since it sends no CORS headers).
import { expect, test } from "@playwright/test";
import { faucet, lncli, mine } from "../../../test/e2e/support/regtest.js";
import { boardingAddressOf, readLocalStack, useLocalStack } from "./local-stack.js";

const SATS = 2000;
const sats = (text: string) => Number(text.trim().split(" ")[0]);

test("a browser wallet routes a BOLT11 over the solver's lightning corridor", async ({ page }) => {
  test.setTimeout(12 * 60_000);
  const stack = readLocalStack();
  await useLocalStack(page, stack);

  const solverCalls: string[] = [];
  const blocked: string[] = [];
  const registryCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/solver/")) solverCalls.push(r.url());
    if (r.url().includes("solver-registry.json")) registryCalls.push(r.url());
  });
  page.on("requestfailed", (r) => { if (r.url().includes("/solver")) blocked.push(`${r.url()} :: ${r.failure()?.errorText}`); });

  await page.goto("./");
  const username = `snd${Date.now().toString(36)}`;
  await page.getByPlaceholder("username").fill(username);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible({ timeout: 120_000 });

  const boardingAddress = await boardingAddressOf(stack.lnurlBase, username);
  await faucet(boardingAddress, "0.001");
  await mine(1);
  await expect
    .poll(async () => {
      await page.getByRole("button", { name: "Refresh" }).click();
      return sats(await page.locator("div").filter({ hasText: /^\d+ sats$/ }).first().innerText());
    }, { timeout: 240_000, intervals: [5_000] })
    .toBeGreaterThan(0);

  const invoice = (await lncli<{ payment_request: string }>("lnd", ["addinvoice", "--amt", String(SATS)])).payment_request;
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByPlaceholder(/name@domain/).fill(invoice);
  await page.locator('input[type="number"]').fill(String(SATS));
  await page.getByRole("button", { name: "Find routes" }).click();
  await expect(page.getByRole("button", { name: "Find routes" })).toBeEnabled({ timeout: 180_000 });

  console.log(`TRIAGE registry fetched: ${registryCalls.length}`);
  const pay = page.getByRole("button", { name: new RegExp(`Pay ${SATS} sats`) }).first();
  console.log(`TRIAGE routes offered: ${await pay.count()}`);

  // Discovery is the gate: without a reachable registry the rail matches the
  // invoice and then reports an empty market, which reads as "no solver".
  expect(registryCalls.length, "the browser never fetched the local registry").toBeGreaterThan(0);
  await expect(pay, "the solver rail offered no route for the invoice").toBeVisible({ timeout: 60_000 });

  // Resolving a route never touches the solver; quoting is where `connect`
  // builds the transport, so only this puts an RFQ on the wire.
  await pay.click();
  await expect(page.getByText(/sent \d+ sats|payment failed|receiver|solver-lightning ·/)).toBeVisible({ timeout: 300_000 });
  console.log(`TRIAGE solver calls: ${solverCalls.length ? solverCalls.slice(0, 2).join(", ") : "NONE"}`);
  console.log(`TRIAGE blocked: ${blocked.length ? blocked.join(", ") : "none"}`);
  console.log(`TRIAGE status: ${await page.getByText(/sent \d+ sats|payment failed|receiver|solver-lightning ·/).first().innerText()}`);

  expect(solverCalls.length, "the browser never issued an RFQ to the solver").toBeGreaterThan(0);
  expect(blocked, "the solver request was blocked (CORS or transport)").toEqual([]);
});
