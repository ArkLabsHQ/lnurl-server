import { test } from "@playwright/test";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MNEMONIC_KEY, USERNAME_KEY } from "../src/config.js";

// Provisions a PERSISTENT funding wallet by driving the real UI, because
// Wallet.create only works in a browser. Seeds a known mnemonic so the wallet
// is restorable, then reports the addresses to fund.
//
//   npx playwright test provision --project=chromium
//
// Kept out of the default run by its own grep; the mnemonic is written to
// .e2e-cache/, which is gitignored.
const STORE = resolve(process.cwd(), "../../.e2e-cache/demo-wallet.json");

test("provision a funding wallet @provision", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(resolve(STORE, ".."), { recursive: true });

  let saved: { mnemonic: string; username: string };
  try {
    saved = JSON.parse(readFileSync(STORE, "utf8"));
  } catch {
    saved = { mnemonic: generateMnemonic(wordlist), username: `demo${Date.now().toString(36)}` };
    writeFileSync(STORE, JSON.stringify(saved, null, 2));
  }

  await page.addInitScript(
    ([k, m]) => { window.localStorage.setItem(k, m); },
    [MNEMONIC_KEY, saved.mnemonic] as const,
  );
  await page.goto("./");

  // Seeding a mnemonic means the app opens the SDK wallet before it renders
  // either screen, so wait for it to settle into one of them. Checking
  // visibility immediately just reads the "Opening wallet" placeholder and
  // skips the fill, which is how the first attempt clicked nothing at all.
  const heading = page.getByRole("heading", { name: "Your Lightning address" });
  const create = page.getByRole("button", { name: "Create wallet" });
  await Promise.race([
    heading.waitFor({ timeout: 120_000 }).catch(() => undefined),
    create.waitFor({ timeout: 120_000 }).catch(() => undefined),
  ]);

  if (await create.isVisible().catch(() => false)) {
    await page.getByPlaceholder("username").fill(saved.username);
    await create.click();
  }
  await heading.waitFor({ timeout: 120_000 });

  const username = await page.evaluate((k) => localStorage.getItem(k), USERNAME_KEY);
  const fields = await page.locator("div").filter({ hasText: /^(tark1|tb1|bcrt1)/ }).allInnerTexts();

  const report = {
    username,
    lightningAddress: (await page.locator("div").allInnerTexts()).find((t) => t.includes("@lnurl.")),
    addresses: [...new Set(fields.map((f) => f.trim().split("\n")[0]))],
  };
  writeFileSync(STORE, JSON.stringify({ ...saved, username, report }, null, 2));
  console.log("PROVISIONED:\n" + JSON.stringify(report, null, 2));
});
