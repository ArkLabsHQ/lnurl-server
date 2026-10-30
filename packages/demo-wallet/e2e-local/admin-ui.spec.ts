// The operator half, driven through the real SPA rather than the API it calls.
// Its own server because every one of these mutates server-wide policy — a
// disabled domain or a required API key would take the other specs down with it.
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { hex } from "@scure/base";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { EsploraProvider, MnemonicIdentity, RestArkProvider, Wallet } from "@arkade-os/sdk";
import { createLnurlClient } from "@arkade-os/lnurl-client";
import { ESPLORA_URL, nodeSqliteStorage } from "../../../test/e2e/support/regtest.js";
import {
  CARDS_FILE,
  STATE_DIR,
  buildDistServer,
  readLocalStack,
  startLnurlServer,
  type LnurlServerHandle,
} from "./local-stack.js";

const LNURL_PORT = 4287;
const ADMIN_PORT = 4288;
const ADMIN_BASE = `http://127.0.0.1:${ADMIN_PORT}`;
const QUOTE_MSAT = 2_500_000;

interface PayRequestBody {
  tag?: string;
  status?: string;
  reason?: string;
  minSendable?: number;
  maxSendable?: number;
  paymentOptions?: Array<{ id: string; type: string }>;
}

const name = (prefix: string) => `${prefix}${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

let server: LnurlServerHandle;
let wallet: Wallet;
let identity: { arkadeAddress: string; boardingAddress: string; claimPublicKey: string };

/** The sidebar, which shares its labels with buttons further down. */
const tab = (page: Page, label: string) =>
  page.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name: label, exact: true });
const rowWith = (page: Page, text: string | RegExp) => page.getByRole("row").filter({ hasText: text });
const dialog = (page: Page) => page.getByRole("dialog");
const search = (page: Page) => page.getByRole("searchbox", { name: "Search", exact: true });

async function register(username: string, opts?: { boarding?: boolean; apiKey?: string }) {
  const token = randomBytes(32).toString("hex");
  const owner = createLnurlClient({ baseUrl: server.base });
  await owner.registerAddress({ token, username, ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}) });
  await owner.registerArkadeIdentity({
    token,
    handle: username,
    arkadeAddress: identity.arkadeAddress,
    claimPublicKey: identity.claimPublicKey,
    ...(opts?.boarding ? { boardingAddress: identity.boardingAddress } : {}),
  });
  return { token, owner };
}

const payRequestOf = async (username: string): Promise<PayRequestBody> =>
  (await (await fetch(`${server.base}/.well-known/lnurlp/${username}`)).json()) as PayRequestBody;

const optionIds = async (username: string): Promise<string[]> =>
  ((await payRequestOf(username)).paymentOptions ?? []).map((o) => o.id);

/** A destination quote: it writes a settlement record for the address without
 *  any money moving, which is all the settlement views need. */
async function quoteArkade(username: string): Promise<void> {
  const url = `${server.base}/.well-known/lnurlp/${username}/callback?amount=${QUOTE_MSAT}&paymentOption=arkade`;
  const body = (await (await fetch(url)).json()) as { status?: string; reason?: string };
  expect(body.status, `arkade quote refused: ${body.reason}`).toBe("OK");
}

test.beforeAll(async () => {
  const stack = readLocalStack();
  await buildDistServer();
  const signer = MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist), { isMainnet: false });
  wallet = await Wallet.create({
    identity: signer,
    arkProvider: new RestArkProvider(stack.arkServer),
    onchainProvider: new EsploraProvider(ESPLORA_URL),
    storage: await nodeSqliteStorage(":memory:"),
    settlementConfig: false,
  });
  identity = {
    arkadeAddress: await wallet.getAddress(),
    boardingAddress: await wallet.getBoardingAddress(),
    claimPublicKey: hex.encode(await signer.compressedPublicKey()),
  };
  server = await startLnurlServer({
    port: LNURL_PORT,
    adminPort: ADMIN_PORT,
    dbPath: join(STATE_DIR, "lnurl-admin.sqlite"),
    cardsFile: CARDS_FILE,
    logName: "lnurl-admin.log",
    entry: "dist",
  });
});

test.afterAll(async () => {
  await server?.stop();
  await wallet?.dispose().catch(() => undefined);
});

test("rails: unchecking one in the Addresses tab removes it from the payRequest", async ({ page }) => {
  const username = name("rl");
  await register(username, { boarding: true });
  expect(await optionIds(username)).toEqual(["lightning", "arkade", "onchain"]);

  await page.goto(ADMIN_BASE);
  await tab(page, "Rails").click();
  await expect(rowWith(page, "Arkade destination")).toContainText("Ready");
  await expect(rowWith(page, "Covenant destinations")).toContainText("Not configured");

  await tab(page, "Addresses").click();
  await search(page).fill(username);
  await rowWith(page, username).getByRole("button", { name: "Manage" }).click();
  const arkade = page.getByRole("checkbox", { name: "Arkade destination", exact: true });
  await expect(arkade).toBeChecked();
  // The operator view has to agree with the payRequest above, which advertises
  // onchain because this address registered a boarding address.
  await expect(page.locator("label").filter({ hasText: "Onchain boarding" })).toContainText("Serving");

  // click, not uncheck: the box is controlled by a round trip to the server, so
  // it holds its old state until that lands and `uncheck` asserts too early.
  await arkade.click();
  await expect(arkade).not.toBeChecked();
  // The other two survive: policy removes one rail, it does not collapse the list.
  await expect.poll(() => optionIds(username)).toEqual(["lightning", "onchain"]);

  await arkade.click();
  await expect(arkade).toBeChecked();
  await expect.poll(() => optionIds(username)).toEqual(["lightning", "arkade", "onchain"]);
});

test("addresses and settlements link both ways, scoped by address id", async ({ page }) => {
  const mine = name("pa");
  const other = name("pb");
  await register(mine);
  await register(other);
  await quoteArkade(mine);
  await quoteArkade(other);

  const scoped: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/settlements?")) scoped.push(r.url()); });

  await page.goto(ADMIN_BASE);
  await tab(page, "Settlements").click();
  await expect(rowWith(page, `${mine}@127.0.0.1`)).toBeVisible();
  await expect(rowWith(page, `${other}@127.0.0.1`)).toBeVisible();

  await tab(page, "Addresses").click();
  await search(page).fill(mine);
  await rowWith(page, mine).getByRole("link", { name: "Payments" }).click();

  const addressFilter = page.getByRole("combobox", { name: "Address", exact: true });
  await expect(addressFilter).toHaveValue(`${mine}@127.0.0.1`);
  await expect(rowWith(page, `${mine}@127.0.0.1`)).toHaveCount(1);
  await expect(rowWith(page, `${other}@127.0.0.1`)).toHaveCount(0);
  expect(scoped.some((u) => /addressId=\d+/.test(u))).toBe(true);

  await page.getByRole("button", { name: "Show all" }).click();
  await expect(rowWith(page, `${other}@127.0.0.1`)).toBeVisible();

  // The Address column is the way back in: it re-scopes to the row it names.
  await rowWith(page, `${other}@127.0.0.1`).getByRole("link", { name: `${other}@127.0.0.1` }).click();
  await expect(addressFilter).toHaveValue(`${other}@127.0.0.1`);
  await expect(rowWith(page, `${mine}@127.0.0.1`)).toHaveCount(0);

  // Typing a whole address into the filter scopes to it as well.
  await addressFilter.fill(`${mine}@127.0.0.1`);
  await expect(rowWith(page, `${other}@127.0.0.1`)).toHaveCount(0);
  await expect(rowWith(page, `${mine}@127.0.0.1`)).toHaveCount(1);
});

test("blacklist: a name blocked in the UI is refused at registration", async ({ page }) => {
  const blocked = name("bl");

  await page.goto(ADMIN_BASE);
  await tab(page, "Blacklist").click();
  await page.getByRole("button", { name: "Block a username" }).first().click();
  await dialog(page).getByRole("combobox", { name: "Username" }).fill(blocked);
  await dialog(page).getByRole("textbox", { name: "Reason" }).fill("e2e");
  await dialog(page).getByRole("button", { name: "Block", exact: true }).click();
  await expect(rowWith(page, blocked)).toContainText("All domains");

  const refused = await register(blocked).catch((e: unknown) => e);
  expect(refused).toMatchObject({ code: "blacklisted", httpStatus: 409 });

  await rowWith(page, blocked).getByRole("button", { name: "Unblock" }).click();
  await expect(rowWith(page, blocked)).toHaveCount(0);
  await register(blocked);
  expect((await payRequestOf(blocked)).tag).toBe("payRequest");
});

test("domains: disabling one in the editor takes its addresses off the air", async ({ page }) => {
  const username = name("dm");
  await register(username);
  expect((await payRequestOf(username)).tag).toBe("payRequest");

  await page.goto(ADMIN_BASE);
  await tab(page, "Domains").click();
  const row = rowWith(page, "127.0.0.1");
  const enabled = dialog(page).getByRole("checkbox", { name: "Enabled", exact: true });
  await row.getByRole("button", { name: "Edit" }).click();
  await enabled.uncheck();
  await dialog(page).getByRole("button", { name: "Save changes" }).click();

  await expect(row).toContainText("Disabled");
  await expect.poll(async () => (await payRequestOf(username)).reason)
    .toBe("Unknown or disabled domain");

  await row.getByRole("button", { name: "Edit" }).click();
  await enabled.check();
  await dialog(page).getByRole("button", { name: "Save changes" }).click();
  await expect(row).toContainText("Enabled");
  await expect.poll(async () => (await payRequestOf(username)).tag).toBe("payRequest");
});

test("settings: an override moves the advertised bounds without a restart", async ({ page }) => {
  const username = name("st");
  await register(username);
  const before = await payRequestOf(username);

  await page.goto(ADMIN_BASE);
  await tab(page, "Settings").click();
  const row = rowWith(page, "Max sendable");
  await row.getByRole("spinbutton").fill("777000");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("Overridden");

  // The pair is an intersection, so a value below every rail's own cap is the
  // one the payRequest must then quote exactly.
  await expect.poll(async () => (await payRequestOf(username)).maxSendable).toBe(777_000);

  await row.getByRole("button", { name: "Reset" }).click();
  await expect(row).not.toContainText("Overridden");
  await expect.poll(async () => (await payRequestOf(username)).maxSendable).toBe(before.maxSendable);
});

test("api keys: requiring one gates registration, and revoking it closes the door", async ({ page }) => {
  await page.goto(ADMIN_BASE);
  await tab(page, "API keys").click();
  await page.getByRole("button", { name: "New key" }).first().click();
  await dialog(page).getByRole("textbox", { name: "Label" }).fill("e2e-key");
  await dialog(page).getByRole("button", { name: "Create key" }).click();
  const key = await dialog(page).getByRole("textbox", { name: "API key" }).inputValue();
  expect(key.length).toBeGreaterThan(16);
  await dialog(page).getByRole("button", { name: "Done" }).click();

  await tab(page, "Domains").click();
  const domain = rowWith(page, "127.0.0.1");
  const requireKey = dialog(page).getByRole("checkbox", { name: "Require API key" });
  await domain.getByRole("button", { name: "Edit" }).click();
  await requireKey.check();
  await dialog(page).getByRole("button", { name: "Save changes" }).click();
  await expect(domain).toContainText("Key required");

  const refused = await register(name("ak")).catch((e: unknown) => e);
  expect(refused).toMatchObject({ httpStatus: 401 });

  const accepted = name("ak");
  await register(accepted, { apiKey: key });
  expect((await payRequestOf(accepted)).tag).toBe("payRequest");

  await tab(page, "API keys").click();
  await rowWith(page, "e2e-key").getByRole("button", { name: "Revoke" }).click();
  await dialog(page).getByRole("button", { name: "Revoke key" }).click();
  await expect(rowWith(page, "e2e-key")).toContainText("Revoked");
  const afterRevoke = await register(name("ak"), { apiKey: key }).catch((e: unknown) => e);
  expect(afterRevoke).toMatchObject({ httpStatus: 401 });

  await tab(page, "Domains").click();
  await domain.getByRole("button", { name: "Edit" }).click();
  await requireKey.uncheck();
  await dialog(page).getByRole("button", { name: "Save changes" }).click();
  await expect(domain).not.toContainText("Key required");
});

test("claim codes: a reissued code claims the reserved name, and the lost one is refused", async ({ page }) => {
  const username = name("rs");
  await page.goto(ADMIN_BASE);
  await tab(page, "Addresses").click();
  await page.getByRole("button", { name: "New address" }).click();
  await dialog(page).getByRole("radio", { name: "Reserve a name" }).check();
  await dialog(page).getByRole("button", { name: "Next" }).click();
  await dialog(page).getByRole("textbox", { name: "Username" }).fill(username);
  await dialog(page).getByRole("button", { name: "Reserve name" }).click();
  const lost = await dialog(page).getByRole("textbox", { name: "Claim code" }).inputValue();
  await dialog(page).getByRole("button", { name: "Done" }).click();

  await search(page).fill(username);
  await rowWith(page, username).getByRole("button", { name: "Manage" }).click();
  await page.getByRole("button", { name: "Reissue code" }).click();
  await dialog(page).getByRole("button", { name: "Reissue code" }).click();
  const fresh = await dialog(page).getByRole("textbox", { name: "Claim code" }).inputValue();
  await dialog(page).getByRole("button", { name: "Done" }).click();

  const owner = createLnurlClient({ baseUrl: server.base });
  const refused = await owner.registerAddress({ token: randomBytes(32).toString("hex"), claimCode: lost }).catch((e: unknown) => e);
  expect(refused).toMatchObject({ code: "invalid_claim", httpStatus: 401 });
  const claimed = await owner.registerAddress({ token: randomBytes(32).toString("hex"), claimCode: fresh });
  expect(claimed.username).toBe(username);
});

// Support's view of "the user says they were paid and nothing shows it". The
// arrivals here are all attributed, because the watcher is running — the value
// under test is that the check reaches the indexer and reports honestly, not
// that it manufactures a discrepancy.
test("reconcile: the address panel and the sweep both report what the indexer holds", async ({ page }) => {
  const mine = name("rc");
  await register(mine);
  await quoteArkade(mine);

  await page.goto(ADMIN_BASE);
  await tab(page, "Addresses").click();
  await search(page).fill(mine);
  await rowWith(page, mine).getByRole("button", { name: "Manage" }).click();
  await page.getByRole("button", { name: "Check arrivals" }).click();

  // Either outcome is a pass: what must not happen is a spinner that never
  // resolves or an error, both of which mean the route is not reachable.
  await expect(
    page.getByText(/No arrivals at this address|No record|Recorded/).first(),
  ).toBeVisible({ timeout: 60_000 });

  // The batch sweep answers the same question across every address at once.
  await tab(page, "Settlements").click();
  await page.getByRole("button", { name: "Check for unrecorded payments" }).click();
  await expect(
    page.getByText(/is accounted for|no settlement record/).first(),
  ).toBeVisible({ timeout: 60_000 });
});
