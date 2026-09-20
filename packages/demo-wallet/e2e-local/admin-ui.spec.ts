// The operator half, driven through the real SPA rather than the API it calls.
// Its own server because every one of these mutates server-wide policy — a
// disabled domain or a required API key would take the other specs down with it.
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { hex } from "@scure/base";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { MnemonicIdentity, Wallet } from "@arkade-os/sdk";
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

/** The tab strip, which shares its labels with per-row buttons further down. */
const tab = (page: Page, label: string) => page.locator("nav").getByRole("button", { name: label, exact: true });
const rowWith = (page: Page, text: string | RegExp) => page.getByRole("row").filter({ hasText: text });

async function register(username: string, opts?: { boarding?: boolean; apiKey?: string }) {
  const token = randomBytes(32).toString("hex");
  const owner = createLnurlClient({ baseUrl: server.base });
  await owner.registerAddress({ token, username, ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}) });
  await owner.registerArkadeIdentity({
    token,
    username,
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
    arkServerUrl: stack.arkServer,
    esploraUrl: ESPLORA_URL,
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
  await expect(rowWith(page, "Arkade destination")).toContainText("ready");
  await expect(rowWith(page, "Covenant destinations")).toContainText("not configured");

  await tab(page, "Addresses").click();
  await page.getByPlaceholder("search username…").fill(username);
  await rowWith(page, username).getByRole("button", { name: "Rails" }).click();
  const arkade = page.locator("label").filter({ hasText: "Arkade destination" }).getByRole("checkbox");
  await expect(arkade).toBeChecked();
  // The operator view has to agree with the payRequest above, which advertises
  // onchain because this address registered a boarding address.
  await expect(page.locator("label").filter({ hasText: "Onchain boarding" })).toContainText("serving");

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
  await page.getByPlaceholder("search username…").fill(mine);
  await rowWith(page, mine).getByRole("button", { name: "Payments" }).click();

  await expect(page.getByText(`Filtered to ${mine}@127.0.0.1`)).toBeVisible();
  await expect(rowWith(page, `${mine}@127.0.0.1`)).toHaveCount(1);
  await expect(rowWith(page, `${other}@127.0.0.1`)).toHaveCount(0);
  expect(scoped.some((u) => /addressId=\d+/.test(u))).toBe(true);

  await page.getByRole("button", { name: "show all" }).click();
  await expect(rowWith(page, `${other}@127.0.0.1`)).toBeVisible();

  // The Address column is the way back in: it re-scopes to the row it names.
  await rowWith(page, `${other}@127.0.0.1`).getByRole("link", { name: `${other}@127.0.0.1` }).click();
  await expect(page.getByText(`Filtered to ${other}@127.0.0.1`)).toBeVisible();
  await expect(rowWith(page, `${mine}@127.0.0.1`)).toHaveCount(0);
});

test("blacklist: a name blocked in the UI is refused at registration", async ({ page }) => {
  const blocked = name("bl");

  await page.goto(ADMIN_BASE);
  await tab(page, "Blacklist").click();
  await page.getByPlaceholder("username").fill(blocked);
  await page.getByPlaceholder("reason (optional)").fill("e2e");
  await page.getByRole("button", { name: "+ Block" }).click();
  await expect(rowWith(page, blocked)).toContainText("global");

  const refused = await register(blocked).catch((e: unknown) => e);
  expect(refused).toMatchObject({ code: "blacklisted", httpStatus: 409 });

  await rowWith(page, blocked).getByRole("button", { name: "Remove" }).click();
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
  await row.getByRole("button", { name: "Edit" }).click();
  const enabled = page.locator("tr", { hasText: "Allocation modes" }).getByRole("checkbox").nth(4);
  await enabled.uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(row).toContainText("no");
  await expect.poll(async () => (await payRequestOf(username)).reason)
    .toBe("Unknown or disabled domain");

  await row.getByRole("button", { name: "Edit" }).click();
  await page.locator("tr", { hasText: "Allocation modes" }).getByRole("checkbox").nth(4).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await payRequestOf(username)).tag).toBe("payRequest");
});

test("settings: an override moves the advertised bounds without a restart", async ({ page }) => {
  const username = name("st");
  await register(username);
  const before = await payRequestOf(username);

  await page.goto(ADMIN_BASE);
  await tab(page, "Settings").click();
  const row = rowWith(page, "Max sendable");
  await row.getByRole("textbox").fill("777000");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("(override)");

  // The pair is an intersection, so a value below every rail's own cap is the
  // one the payRequest must then quote exactly.
  await expect.poll(async () => (await payRequestOf(username)).maxSendable).toBe(777_000);

  await row.getByRole("button", { name: "Reset" }).click();
  await expect(row).not.toContainText("(override)");
  await expect.poll(async () => (await payRequestOf(username)).maxSendable).toBe(before.maxSendable);
});

test("api keys: requiring one gates registration, and revoking it closes the door", async ({ page }) => {
  await page.goto(ADMIN_BASE);
  await tab(page, "API Keys").click();
  await page.getByPlaceholder("label").fill("e2e-key");
  await page.getByRole("button", { name: "+ Create key" }).click();
  const key = (await page.locator("p", { hasText: "Key (copy now)" }).locator("code").innerText()).trim();
  expect(key.length).toBeGreaterThan(16);

  await tab(page, "Domains").click();
  const domain = rowWith(page, "127.0.0.1");
  await domain.getByRole("button", { name: "Edit" }).click();
  await page.locator("tr", { hasText: "Allocation modes" }).getByRole("checkbox").nth(3).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(domain).toContainText("yes");

  const refused = await register(name("ak")).catch((e: unknown) => e);
  expect(refused).toMatchObject({ httpStatus: 401 });

  const accepted = name("ak");
  await register(accepted, { apiKey: key });
  expect((await payRequestOf(accepted)).tag).toBe("payRequest");

  await tab(page, "API Keys").click();
  await rowWith(page, "e2e-key").getByRole("button", { name: "Revoke" }).click();
  await expect(rowWith(page, "e2e-key")).toContainText("revoked");
  const afterRevoke = await register(name("ak"), { apiKey: key }).catch((e: unknown) => e);
  expect(afterRevoke).toMatchObject({ httpStatus: 401 });

  await tab(page, "Domains").click();
  await domain.getByRole("button", { name: "Edit" }).click();
  await page.locator("tr", { hasText: "Allocation modes" }).getByRole("checkbox").nth(3).uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(domain).toContainText("no");
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
  await page.getByPlaceholder("search username…").fill(mine);
  await rowWith(page, mine).getByRole("button", { name: "Reconcile" }).click();

  // Either outcome is a pass: what must not happen is a spinner that never
  // resolves or an error, both of which mean the route is not reachable.
  await expect(
    page.getByText(/No arrivals at this address|no record|Recorded/).first(),
  ).toBeVisible({ timeout: 60_000 });

  // The batch sweep answers the same question across every address at once.
  await tab(page, "Settlements").click();
  await page.getByRole("button", { name: "Check for unrecorded payments" }).click();
  await expect(
    page.getByText(/is accounted for|have no settlement record/).first(),
  ).toBeVisible({ timeout: 60_000 });
});
