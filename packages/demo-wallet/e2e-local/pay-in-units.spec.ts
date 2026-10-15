// A payer prices a payment in the receiver's unit (USD), the receiver's server
// quotes it from a price feed, and both wallets' history keeps the dollars.
import { expect, test, type Page } from "@playwright/test";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { bech32 } from "@scure/base";
import { faucet, mine } from "../../../test/e2e/support/regtest.js";
import {
  CARDS_FILE,
  STATE_DIR,
  forwardPortlessCallbacks,
  requestOption,
  WALLET_PORT,
  readLocalStack,
  startLnurlServer,
  useLocalStack,
  type LnurlServerHandle,
  type LocalStack,
} from "./local-stack.js";

const SERVER_PORT = 4295;
const ADMIN_PORT = 4296;
const FEED_PORT = 4297;
const WALLET_BASE = `http://127.0.0.1:${WALLET_PORT}`;
// $1.00 at $50,000 is exactly 2000 sats.
const USD = "1.00";
const QUOTED_SATS = 2000;
const SETTLE_TIMEOUT_MS = 4 * 60_000;

let stack: LocalStack;
let server: LnurlServerHandle;
let feed: http.Server;
let recipient: { page: Page; username: string };
let payer: Page;

const balance = (page: Page) =>
  page.locator("div").filter({ hasText: /^\d+ sats$/ }).first().innerText().then((t) => Number(t.trim().split(" ")[0]));
const name = (prefix: string) => `${prefix}${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

async function onboard(page: Page, prefix: string): Promise<string> {
  const username = name(prefix);
  await page.goto("./");
  await page.getByPlaceholder("username").fill(username);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible({ timeout: 120_000 });
  return username;
}

async function statusReaches(page: Page, pattern: RegExp, timeoutMs: number): Promise<void> {
  const seen: string[] = [];
  const status = page.locator('p[style*="ui-monospace"]').last();
  await expect
    .poll(async () => {
      const text = await status.innerText().catch(() => "");
      if (text && seen.at(-1) !== text) seen.push(text);
      return seen.join(" | ");
    }, { timeout: timeoutMs, intervals: [1000] })
    .toMatch(pattern);
}

function feedOf(page: Page) {
  return page.locator("div").filter({ has: page.getByRole("heading", { name: "Activity" }) }).last();
}

test.beforeAll(async ({ browser }) => {
  stack = readLocalStack();
  feed = http.createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"usd":"50000"}'));
  await new Promise<void>((r) => feed.listen(FEED_PORT, "127.0.0.1", () => r()));
  server = await startLnurlServer({
    port: SERVER_PORT,
    adminPort: ADMIN_PORT,
    dbPath: join(STATE_DIR, "lnurl-pay-in-units.sqlite"),
    cardsFile: CARDS_FILE,
    logName: "lnurl-pay-in-units.log",
    env: {
      OFFLINE_COVENANT_DESTINATIONS: "true",
      QUOTE_UNITS: "USD",
      QUOTE_USD_FEED_URL: `http://127.0.0.1:${FEED_PORT}/`,
      QUOTE_USD_PRICE_PATH: "/usd",
      QUOTE_USD_DECIMALS: "2",
    },
  });
  // The feed is optional for readiness, so wait for it rather than for the server.
  await expect.poll(async () => {
    const ready = await fetch(`${server.base}/readyz`).then((r) => r.json(), () => ({})) as { components?: { priceFeeds?: { ok?: boolean } } };
    return ready.components?.priceFeeds?.ok;
  }, { timeout: 60_000 }).toBe(true);

  const recipientPage = await (await browser.newContext({ baseURL: WALLET_BASE })).newPage();
  await useLocalStack(recipientPage, { ...stack, lnurlBase: server.base });
  recipient = { page: recipientPage, username: await onboard(recipientPage, "usd") };

  payer = await (await browser.newContext({ baseURL: WALLET_BASE })).newPage();
  await useLocalStack(payer, stack);
  await forwardPortlessCallbacks(payer, SERVER_PORT);
  const payerName = await onboard(payer, "payusd");
  const boardingAddress = (await requestOption(stack.lnurlBase, payerName, 1000, "onchain")).paymentDestination!;
  await faucet(boardingAddress, "0.001");
  await mine(1);
  await expect
    .poll(async () => {
      await payer.getByRole("button", { name: "Refresh" }).click();
      return balance(payer);
    }, { timeout: 300_000, intervals: [5_000] })
    .toBeGreaterThan(QUOTED_SATS);
});

test.afterAll(async () => {
  await recipient?.page.context().close();
  await payer?.context().close();
  await server?.stop();
  await new Promise((r) => feed?.close(r));
});

test("lnurl-arkade in USD: the receiver quotes the sats, and both feeds keep the dollars", async () => {
  const url = `${server.base}/.well-known/lnurlp/${recipient.username}`;
  const lnurl = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 1023);
  // Polled, not read once: a refresh renders 0 mid-fetch, which as the baseline
  // makes the drop below unsatisfiable (send-paths.spec.ts hit the same).
  await expect.poll(() => balance(payer), { timeout: 120_000, intervals: [1_000] }).toBeGreaterThan(QUOTED_SATS);
  const payerBefore = await balance(payer);

  await payer.getByRole("button", { name: "Send" }).click();
  await payer.getByPlaceholder(/name@domain/).fill(lnurl);
  // The unit choice appears once the target's payRequest has resolved.
  await payer.getByLabel("amount unit").selectOption("USD", { timeout: 60_000 });
  await payer.getByLabel("amount in USD").fill(USD);
  await payer.getByRole("button", { name: "Find routes" }).click();
  const option = payer.locator("div").filter({ hasText: /^lnurl-arkadeQuote/ }).first();
  await expect(option, "lnurl-arkade offered no route in USD").toBeVisible({ timeout: 120_000 });
  await option.getByRole("button", { name: "Quote" }).click();
  // Page-level: the row stops matching `^lnurl-arkadeQuote` once it is quoted.
  await expect(payer.getByText(/2000 sats \+ \d+ fee · 1\.00 USD/)).toBeVisible({ timeout: 120_000 });
  await payer.getByRole("button", { name: /^Pay \d+ sats$/ }).click();

  await statusReaches(payer, /sent \d+ sats via lnurl-arkade|lnurl-arkade · /, 180_000);
  await expect.poll(() => balance(payer), { timeout: 120_000, intervals: [3_000] }).toBeLessThanOrEqual(payerBefore - QUOTED_SATS);
  await statusReaches(payer, /receiver confirmed settled via lnurl-arkade/, SETTLE_TIMEOUT_MS);

  await payer.getByRole("button", { name: "Activity" }).click();
  const payerFeed = feedOf(payer);
  await expect(payerFeed).toContainText(`→ ${lnurl}`, { timeout: 60_000 });
  await payerFeed.getByRole("button", { name: "▸" }).first().click();
  await expect(payerFeed).toContainText("requested");
  await expect(payerFeed).toContainText(`${USD} USD`);

  await recipient.page.getByRole("button", { name: "Activity" }).click();
  const recipientFeed = feedOf(recipient.page);
  await expect(recipientFeed).toContainText(`${QUOTED_SATS} sats`, { timeout: SETTLE_TIMEOUT_MS });
  await recipientFeed.getByRole("button", { name: "▸" }).first().click();
  await expect(recipientFeed).toContainText("requested");
  await expect(recipientFeed).toContainText(`${USD} USD`);
});
