// A wallet that never picks a name: it receives at a bare LNURL with the page
// closed, then names itself in place and keeps receiving at both.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { bech32 } from "@scure/base";
import { mine, payFromCounterparty, pollUntil } from "../../../test/e2e/support/regtest.js";
import { LNURL_ADMIN_PORT, readLocalStack, useLocalStack, type LocalStack } from "./local-stack.js";

const SATS = 5000;
const SWAP_TIMEOUT_MS = 12 * 60_000;
const ADMIN = `http://127.0.0.1:${LNURL_ADMIN_PORT}/admin/api`;

interface DomainRow { id: number; domain: string; allocationModes: string[] }

const decodeLnurl = (lnurl: string): string =>
  new TextDecoder().decode(bech32.fromWords(bech32.decode(lnurl as `${string}1${string}`, 1023).words));

async function setModes(stack: LocalStack, modes: (current: string[]) => string[]): Promise<string[]> {
  const rows = (await (await fetch(`${ADMIN}/domains`)).json()) as DomainRow[];
  const row = rows.find((d) => d.domain === stack.lnurlDomain);
  if (!row) throw new Error(`no ${stack.lnurlDomain} domain on the admin API`);
  const res = await fetch(`${ADMIN}/domains/${row.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allocationModes: modes(row.allocationModes) }),
  });
  if (!res.ok) throw new Error(`domain patch -> HTTP ${res.status}: ${await res.text()}`);
  return row.allocationModes;
}

/** The advertised URLs name the LUD-16 domain, which has no port here. */
const onServer = (stack: LocalStack, advertised: string): string => {
  const url = new URL(advertised);
  return new URL(`${url.pathname}${url.search}`, stack.lnurlBase).toString();
};

async function invoiceFor(stack: LocalStack, payRequestUrl: string): Promise<{ pr: string; verify: string }> {
  const payRequest = await (await fetch(payRequestUrl)).json();
  expect(payRequest.tag, `${payRequestUrl} did not resolve: ${payRequest.reason}`).toBe("payRequest");
  const callback = new URL(onServer(stack, String(payRequest.callback)));
  callback.searchParams.set("amount", String(SATS * 1000));
  const body = await (await fetch(callback)).json();
  expect(body.status, `callback refused: ${body.reason}`).not.toBe("ERROR");
  expect(String(body.pr)).toMatch(/^lnbcrt/);
  return { pr: String(body.pr), verify: onServer(stack, String(body.verify)) };
}

async function payAll(invoices: { pr: string; verify: string }[]): Promise<void> {
  const payers = invoices.map((i) => payFromCounterparty(i.pr));
  const settled = new Set<string>();
  let blocks = 0;
  let lastMine = 0;
  try {
    await pollUntil(
      "every verify settled",
      async () => {
        if (blocks < 24 && Date.now() - lastMine > 15_000) {
          await mine(1);
          blocks += 1;
          lastMine = Date.now();
        }
        for (const { verify } of invoices) {
          if (!settled.has(verify) && (await (await fetch(verify)).json()).settled === true) settled.add(verify);
        }
        return settled.size === invoices.length;
      },
      SWAP_TIMEOUT_MS,
      3000,
      () => `${settled.size}/${invoices.length} settled after ${blocks} blocks`,
    );
  } finally {
    for (const p of payers) p.stop();
  }
}

async function openWallet(context: BrowserContext, stack: LocalStack): Promise<Page> {
  const page = await context.newPage();
  await useLocalStack(page, stack, { keepExisting: true });
  await page.goto("./");
  return page;
}

const lightningRows = (page: Page) => page.locator('span[title="lightning"]');

async function activityShows(page: Page, count: number): Promise<void> {
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 60_000 });
  await expect(lightningRows(page)).toHaveCount(count, { timeout: 120_000 });
  await expect(page.getByText("pending", { exact: true })).toHaveCount(0);
}

let stack: LocalStack;
let restoreModes: string[] | undefined;

test.beforeAll(async () => {
  stack = readLocalStack();
  restoreModes = await setModes(stack, (modes) => [...new Set([...modes, "session"])]);
});

test.afterAll(async () => {
  if (restoreModes) await setModes(stack, () => restoreModes!);
});

test("a nameless wallet receives offline at its LNURL, then takes a name and receives at both", async ({ browser }) => {
  test.setTimeout(3 * SWAP_TIMEOUT_MS);
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    let page = await openWallet(context, stack);
    await page.getByRole("button", { name: "Skip — just a LNURL" }).click({ timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Your LNURL" })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(`@${stack.lnurlDomain}`)).toHaveCount(0);

    const lnurl = (await page.getByText(/^lnurl1[0-9a-z]+$/).first().innerText()).trim();
    const lnurlUrl = decodeLnurl(lnurl);
    expect(lnurlUrl).toMatch(new RegExp(`^${stack.lnurlBase}/lnurl/[0-9a-f]{32}$`));

    await page.getByRole("button", { name: /Load options/ }).click();
    await expect(page.getByText(/accepts \d+/)).toBeVisible({ timeout: 60_000 });

    await page.close();
    await payAll([await invoiceFor(stack, lnurlUrl)]);

    page = await openWallet(context, stack);
    await expect(page.getByRole("heading", { name: "Your LNURL" })).toBeVisible({ timeout: 120_000 });
    await activityShows(page, 1);

    const username = `nl${Date.now().toString(36)}`;
    await page.getByRole("button", { name: "Receive" }).click();
    await page.getByPlaceholder("username").fill(username);
    await page.getByRole("button", { name: "Add a name" }).click({ timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(`${username}@${stack.lnurlDomain}`)).toBeVisible();

    await payAll([
      await invoiceFor(stack, `${stack.lnurlBase}/.well-known/lnurlp/${username}`),
      await invoiceFor(stack, lnurlUrl),
    ]);
    await activityShows(page, 3);
  } finally {
    await context.close();
  }
});
