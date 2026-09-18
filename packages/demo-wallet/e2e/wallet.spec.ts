import { expect, test, type Page } from "@playwright/test";
import { MnemonicIdentity } from "@arkade-os/sdk";
import { createLnurlClient } from "@arkade-os/lnurl-client";
import { deriveSessionTokenForIdentity } from "@arkade-os/lnurl-client/arkade";
import { IS_MAINNET, LNURL_BASE, LNURL_DOMAIN as DOMAIN, MNEMONIC_KEY, USERNAME_KEY } from "../src/config.js";

// Drives the built bundle in a real browser against the real mutinynet
// endpoints. Everything below the UI — IndexedDB, WebCrypto, the SDK's browser
// paths — only exists here: a green unit suite and a clean type-check both
// passed while the wallet could not create an identity at all.
const LNURL_DOMAIN = DOMAIN;

// "./" and not "/": a baseURL carrying a path (a Pages project site lives at
// /<repo>/) is discarded by an absolute path, so goto("/") lands on the org
// root and 404s. Relative keeps the prefix, and still resolves to the root on a
// bare host.

/** A username nobody else is using, short enough for the server's policy. */
const username = () => `e2e${Date.now().toString(36)}`;

/**
 * Revokes whatever the run claimed.
 *
 * These tests register on a shared instance, so without this every CI run
 * leaves another address behind for good. The mnemonic is read back out of the
 * page and the token re-derived here, which is the same value the wallet
 * derived — that it round-trips at all is itself worth knowing.
 */
async function cleanUp(page: Page) {
  const stored = await page.evaluate(
    ([m, u]) => ({ mnemonic: localStorage.getItem(m), username: localStorage.getItem(u) }),
    [MNEMONIC_KEY, USERNAME_KEY] as const,
  );
  if (!stored.mnemonic || !stored.username) return;
  const identity = MnemonicIdentity.fromMnemonic(stored.mnemonic, { isMainnet: IS_MAINNET });
  const token = await deriveSessionTokenForIdentity(identity, LNURL_DOMAIN);
  await createLnurlClient({ baseUrl: LNURL_BASE }).revokeAddress(token, stored.username).catch(() => undefined);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test.afterEach(async ({ page }) => {
  await cleanUp(page);
});

test("loads and offers onboarding", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("./");

  await expect(page.getByRole("heading", { name: "Arkade demo wallet" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create your wallet" })).toBeVisible();
  await expect(page.getByPlaceholder("username")).toBeVisible();
  expect(errors).toEqual([]);
});

test("keeps Create disabled until the username is long enough", async ({ page }) => {
  await page.goto("./");
  const create = page.getByRole("button", { name: "Create wallet" });

  await expect(create).toBeDisabled();
  await page.getByPlaceholder("username").fill("ab");
  await expect(create).toBeDisabled();
  await page.getByPlaceholder("username").fill("abc");
  await expect(create).toBeEnabled();
});

test("onboards against mutinynet and shows an address at the pinned domain", async ({ page }) => {
  const name = username();
  await page.goto("./");

  await page.getByPlaceholder("username").fill(name);
  await page.getByRole("button", { name: "Create wallet" }).click();

  // The wallet is past onboarding only when the receive page is up. Asserting
  // the absence of an error first gives the real message when this fails,
  // rather than a timeout on some later locator.
  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible();

  // The domain is the pinned one, never the page's own host: served from GitHub
  // Pages, location.hostname is github.io and serves no LNURL.
  await expect(page.getByText(`${name}@${LNURL_DOMAIN}`)).toBeVisible();
});

test("shows the Arkade address, a QR and a boarding address to fund", async ({ page }) => {
  await page.goto("./");
  await page.getByPlaceholder("username").fill(username());
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible();

  await expect(page.getByAltText("QR code")).toBeVisible();
  await expect(page.getByText(/^tark1/).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fund this wallet" })).toBeVisible();
});

test("toggles the receive QR between the lightning address and a unified URI", async ({ page }) => {
  await page.goto("./");
  await page.getByPlaceholder("username").fill(username());
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible();

  await expect(page.getByText("Lightning only")).toBeVisible();

  await page.getByRole("button", { name: "Unified (BIP321)" }).click();
  await expect(page.getByText("on-chain · Arkade · Lightning")).toBeVisible();
  await expect(page.getByAltText("QR code")).toBeVisible();
});

test("routes the send box through the payment router", async ({ page }) => {
  await page.goto("./");
  await page.getByPlaceholder("username").fill(username());
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible();

  await page.getByRole("button", { name: "Send" }).click();
  await page.getByPlaceholder(/name@domain/).fill("nobody-here-at-all@lnurl.mutinynet.arkade.sh");
  await page.getByRole("button", { name: "Find routes" }).click();

  // An unregistered address resolves to nothing payable, so every rail drops
  // itself — the router reporting that is the behaviour under test.
  await expect(page.getByText(/no rail can pay|routing failed/i)).toBeVisible();
});

test("lists payment activity for the freshly claimed address", async ({ page }) => {
  await page.goto("./");
  await page.getByPlaceholder("username").fill(username());
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible();

  await page.getByRole("button", { name: "Activity" }).click();

  await expect(page.getByText("No payments yet.")).toBeVisible();
});
