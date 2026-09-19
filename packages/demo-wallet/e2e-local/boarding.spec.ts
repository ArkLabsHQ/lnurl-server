// Onchain arrivals are inert until `autoSettleBoarding` converts them, and that
// runs only in a browser — so this is the one place the boarding path is real.
//
// The solver-lightning SEND rail is deliberately NOT asserted here: on regtest
// the browser cannot discover the stack's solver at all. Discovery is registry
// based (`defaultRegistryUrls("regtest")` is the public GitHub Pages index),
// while the local solver's card exists only in the file the server reads via
// SOLVER_CARDS_FILE. Routes come back empty before any transport is chosen, so a
// send assertion here would fail for discovery reasons and say nothing about the
// rail. Serving that card to the browser is what would unblock it.
import { expect, test } from "@playwright/test";
import { faucet, mine } from "../../../test/e2e/support/regtest.js";
import { readLocalStack, useLocalStack } from "./local-stack.js";

const sats = (text: string) => Number(text.trim().split(" ")[0]);

test("a browser wallet boards a confirmed onchain deposit into spendable funds", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await useLocalStack(page, readLocalStack());

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("./");
  await page.getByPlaceholder("username").fill(`brd${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible({ timeout: 120_000 });

  const balanceBefore = sats(await page.locator("div").filter({ hasText: /^\d+ sats$/ }).first().innerText());
  const boardingAddress = (await page.getByText(/^bcrt1/).first().innerText()).trim();
  expect(boardingAddress).toMatch(/^bcrt1/);

  await faucet(boardingAddress, "0.001");
  // Unconfirmed deposits have no boarding input to spend, so the poller ignores
  // them until this — the negative the test would otherwise race past.
  await mine(1);

  await expect
    .poll(async () => {
      await page.getByRole("button", { name: "Refresh" }).click();
      return sats(await page.locator("div").filter({ hasText: /^\d+ sats$/ }).first().innerText());
    }, { timeout: 240_000, intervals: [5_000] })
    .toBeGreaterThan(balanceBefore);

  expect(errors).toEqual([]);
});
