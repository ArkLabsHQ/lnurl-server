import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MNEMONIC_KEY, USERNAME_KEY } from "../src/config.js";

/**
 * Real money, both directions, both rails, on mutinynet.
 *
 * payment.spec.ts proves one payment over one rail in one direction. That
 * leaves the interesting half untested: whether a wallet that has only ever
 * RECEIVED can turn around and pay, and whether each rail works in the
 * direction it was not exercised in. A rail is a different code path each way —
 * sending over `lnurl-lightning` quotes a solver invoice, receiving over it
 * settles a covenant — so passing one direction says nothing about the other.
 *
 * The matrix is direction x rail:
 *
 *            lnurl-arkade   lnurl-lightning
 *   A -> B        1                3
 *   B -> A        2                4
 *
 * B is funded entirely by leg 1. Everything B spends afterwards is money it
 * received in this test, which is the point: it proves a received balance is
 * genuinely spendable and not just a number the UI renders.
 *
 * @funded — needs the persistent wallet `provision.spec.ts` mints, topped up by
 * hand. Skipped in CI like the other funded specs.
 */
const STORE = resolve(process.cwd(), "../../.e2e-cache/demo-wallet.json");
const DOMAIN = "lnurl.mutinynet.arkade.sh";

/** Small enough to run the whole matrix on a modest float, large enough to sit
 *  above the arkade rail's dust floor with fees taken out on every hop. */
const AMOUNT = 1_500;
/** B is seeded once and then spends twice, so the first leg has to cover both
 *  onward legs plus whatever each hop costs. */
const SEED = AMOUNT * 3;

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

async function newWallet(browser: Browser, prefix: string): Promise<{ page: Page; address: string }> {
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(() => localStorage.clear());
  await page.goto("./");
  const name = `${prefix}${Date.now().toString(36)}`;
  await page.getByPlaceholder("username").fill(name);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await page.getByRole("heading", { name: "Your Lightning address" }).waitFor({ timeout: 120_000 });
  return { page, address: `${name}@${DOMAIN}` };
}

/**
 * One leg. Returns once the payer's own balance has dropped, which is the only
 * proof that does not come from our own status text.
 */
async function pay(from: Page, to: string, amount: number, railId: string, label: string): Promise<void> {
  const before = await balanceOf(from);
  expect(before, `${label}: payer holds ${before}, needs more than ${amount}`).toBeGreaterThan(amount);

  await from.getByRole("button", { name: "Send" }).click();
  await from.getByPlaceholder(/name@domain/).fill(to);
  await from.locator('input[type="number"]').fill(String(amount));
  await from.getByRole("button", { name: "Find routes" }).click();

  const row = from.locator("div").filter({ hasText: new RegExp(`^${railId}`) }).first();
  await expect(row, `${label}: ${railId} was not offered`).toBeVisible({ timeout: 60_000 });
  await row.getByRole("button", { name: /Pay/ }).click();

  await expect(from.getByText(new RegExp(`sent \\d+ sats via ${railId}|${railId} · `)))
    .toBeVisible({ timeout: 180_000 });
  await expect
    .poll(async () => balanceOf(from), { timeout: 180_000, intervals: [3_000] })
    .toBeLessThanOrEqual(before - amount);

  // The SETTLED balance, not the first reading that happens to be lower. An
  // offboard transiently reports 0 while it settles — spending 12k out of 985k
  // was observed showing a zero balance mid-flight — and a bare "it went down"
  // assertion is satisfied by that, so it would pass just as happily if the
  // money had actually gone. Requiring a plausible floor is what makes this a
  // debit rather than a disappearance.
  await expect
    .poll(async () => balanceOf(from), { timeout: 300_000, intervals: [5_000] })
    .toBeGreaterThanOrEqual(Math.max(0, before - amount * 2));
  console.log(`MATRIX ${label}: ${amount} sats over ${railId} — payer ${before} -> ${await balanceOf(from)}`);
}

/** Arrival, never the exact figure: every hop takes a fee, so the only honest
 *  assertion is that the recipient gained something. */
async function gained(page: Page, before: number, label: string): Promise<void> {
  await expect
    .poll(async () => {
      await page.getByRole("button", { name: "Refresh" }).click();
      return balanceOf(page);
    }, { timeout: 240_000, intervals: [5_000] })
    .toBeGreaterThan(before);
  console.log(`MATRIX ${label}: recipient ${before} -> ${await balanceOf(page)}`);
}

test("pays both directions over both rails between two lightning addresses @funded", async ({ browser }) => {
  test.setTimeout(900_000);

  const a = await openFunded(browser);
  const b = await newWallet(browser, "mx");
  console.log(`MATRIX A=${a.address} B=${b.address}`);

  try {
    // Leg 1 — A -> B over arkade. Also the seeding round: B starts at zero and
    // every later leg it pays is funded by this.
    const bEmpty = await balanceOf(b.page);
    await pay(a.page, b.address, SEED, "lnurl-arkade", "A->B arkade (seed)");
    await gained(b.page, bEmpty, "A->B arkade (seed)");

    // Leg 2 — B -> A over arkade. The direction payment.spec.ts never covers:
    // a wallet spending money it only ever received.
    const aBefore2 = await balanceOf(a.page);
    await pay(b.page, a.address, AMOUNT, "lnurl-arkade", "B->A arkade");
    await gained(a.page, aBefore2, "B->A arkade");

    // Leg 3 — A -> B over lightning. A different path entirely: the payer
    // quotes a solver hold invoice and the receiver settles through a covenant.
    const bBefore3 = await balanceOf(b.page);
    await pay(a.page, b.address, AMOUNT, "lnurl-lightning", "A->B lightning");
    await gained(b.page, bBefore3, "A->B lightning");

    // Leg 4 — B -> A over lightning, closing the matrix.
    const aBefore4 = await balanceOf(a.page);
    await pay(b.page, a.address, AMOUNT, "lnurl-lightning", "B->A lightning");
    await gained(a.page, aBefore4, "B->A lightning");

    // Both wallets should show the SDK's own view of what moved, not just the
    // server's record of what was quoted.
    for (const [page, who] of [[a.page, "A"], [b.page, "B"]] as const) {
      await page.getByRole("button", { name: "Activity" }).click();
      await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
      await expect(page.locator("div").filter({ hasText: /^wallet/ }).first())
        .toBeVisible({ timeout: 120_000 });
      await expect(page.getByText(/wallet history unavailable/)).toHaveCount(0);
      console.log(`MATRIX ${who} activity shows wallet-sourced rows`);
    }
  } finally {
    await a.page.close();
    await b.page.close();
  }
});

/**
 * The third rail, which the matrix above cannot reach.
 *
 * There is no `lnurl-onchain` rail: `lnurlRails` builds one for `arkade` and
 * optionally `lightning` and nothing else, so the router will not route a
 * Lightning address over its onchain option. The leg is therefore two steps —
 * ask the address for a boarding address, then pay THAT — which is exactly what
 * the receive screen tells a payer to do.
 *
 * One direction only. The onchain option enforces ONCHAIN_MIN_SENDABLE_SATS
 * (10k), which is an economic floor rather than dust, and a wallet seeded by
 * the matrix above does not hold enough to send it back. Asymmetry in the test
 * reflects asymmetry in the rail, not an omission.
 *
 * Slow by nature: the payer offboards (a batch settlement) and the recipient
 * boards (an onchain confirmation plus a settle), so this is minutes, not
 * seconds.
 */
test("pays a lightning address's onchain option by offboarding to its boarding address @funded", async ({ browser }) => {
  test.setTimeout(1_800_000);

  const a = await openFunded(browser);
  const b = await newWallet(browser, "ob");
  const ONCHAIN = 12_000;

  try {
    // Ask B's own address what it accepts, and take the boarding address it
    // hands back — the flow the receive screen describes, not a scraped field.
    await b.page.getByRole("button", { name: "Receive" }).click();
    await b.page.getByRole("button", { name: /Load options/ }).click();
    await expect(b.page.getByText(/accepts \d+/)).toBeVisible({ timeout: 60_000 });
    await b.page.getByRole("spinbutton").fill(String(ONCHAIN));
    await b.page.locator("div").filter({ hasText: /^onchain/ }).first()
      .getByRole("button", { name: /Request/ }).click();
    await expect(b.page.getByText(/onchain — pay this/)).toBeVisible({ timeout: 60_000 });
    // Nothing watches Bitcoin server-side, so this rail says so rather than
    // offering a verify URL it could never answer.
    await expect(b.page.getByText(/no verify on this rail/)).toBeVisible();

    const boarding = (await b.page.getByText(/^(tb1|bcrt1|bc1)/).first().innerText()).trim();
    console.log(`ONCHAIN B boarding address: ${boarding}`);

    const aBefore = await balanceOf(a.page);
    const bBefore = await balanceOf(b.page);

    // The generic onchain rail, which offboards VTXOs to a Bitcoin address.
    // Nothing asserts the settling indicator: `intentLocked` is always 0 here.
    await pay(a.page, boarding, ONCHAIN, "onchain", "A->B onchain");

    // Arrival is the whole point and the slowest part: the offboard has to
    // confirm, then B's wallet boards it back into a VTXO on its own.
    await expect
      .poll(async () => {
        await b.page.getByRole("button", { name: "Refresh" }).click();
        return balanceOf(b.page);
      }, { timeout: 1_500_000, intervals: [15_000] })
      .toBeGreaterThan(bBefore);
    console.log(`ONCHAIN A ${aBefore} -> ${await balanceOf(a.page)} | B ${bBefore} -> ${await balanceOf(b.page)}`);
  } finally {
    await a.page.close();
    await b.page.close();
  }
});
