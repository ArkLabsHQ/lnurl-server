// Does a browser wallet surface an Arkade transfer it did not make itself?
//
// A Node wallet built from the same phrase sees one immediately (spendable as
// soon as it is preconfirmed) and can spend it, so the
// money is the recipient's. This asks the only remaining question: whether the
// wallet in the page sees it too.
import { expect, test, type Page } from "@playwright/test";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ArkAddress, MnemonicIdentity, RestIndexerProvider, Wallet } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { ESPLORA_URL, faucet, mine, nodeSqliteStorage } from "../../../test/e2e/support/regtest.js";
import { readLocalStack, requestOption, useLocalStack } from "./local-stack.js";

const SENT = 5000;
const stack = () => readLocalStack();

const shown = (page: Page) =>
  page.locator("div").filter({ hasText: /^\d+ sats$/ }).first().innerText().then((t) => Number(t.trim().split(" ")[0]));

async function fundedPayer(arkServer: string): Promise<Wallet> {
  const wallet = await Wallet.create({
    identity: MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist), { isMainnet: false }),
    arkServerUrl: arkServer,
    esploraUrl: ESPLORA_URL,
    storage: await nodeSqliteStorage(":memory:"),
    settlementConfig: false,
  });
  await faucet(await wallet.getBoardingAddress(), "0.002");
  await mine(1);
  for (let i = 1; ; i++) {
    try { await wallet.settle(); break; } catch (err) {
      if (!String(err).includes("No inputs found") || i >= 15) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await mine(1);
  return wallet;
}

test("a browser wallet surfaces an incoming Arkade transfer it did not make", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const local = stack();
  await useLocalStack(page, local);

  await page.goto("./");
  const username = `inc${Date.now().toString(36)}`;
  await page.getByPlaceholder("username").fill(username);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByRole("heading", { name: "Your Lightning address" })).toBeVisible({ timeout: 120_000 });

  // The wallet prints no Arkade address; on a server without covenant
  // destinations the `arkade` rail answers with the registered static one.
  const { paymentDestination } = await requestOption(local.lnurlBase, username, SENT, "arkade");
  const address = paymentDestination!;
  expect(address).toMatch(/^tark1/);
  const payer = await fundedPayer(local.arkServer);
  const txid = await payer.sendBitcoin({ address, amount: SENT });

  // Independent of any wallet: the money is at the recipient's script.
  const script = hex.encode(ArkAddress.decode(address).pkScript);
  await expect
    .poll(async () => (await new RestIndexerProvider(local.arkServer)
      .getVtxos({ scripts: [script], spendableOnly: true })).vtxos.map((v) => v.value), { timeout: 60_000, intervals: [2_000] })
    .toContain(SENT);
  console.log(`TRIAGE paid ${SENT} -> ${txid}; indexer confirms it at the recipient's script`);

  // Arrival, not the exact figure: `available` nets off what the SDK reserves,
  // so pinning it to SENT asserts a fee policy rather than a receive.
  await expect
    .poll(async () => {
      await page.getByRole("button", { name: "Refresh" }).click();
      return shown(page);
    }, { timeout: 180_000, intervals: [5_000] })
    .toBeGreaterThan(0);

  // One unified figure now; the settled/preconfirmed split is no longer rendered.
  console.log(`TRIAGE browser shows: ${await shown(page)} sats`);
  const vtxos = (await new RestIndexerProvider(local.arkServer)
    .getVtxos({ scripts: [script], spendableOnly: true })).vtxos;
  console.log(`TRIAGE indexer vtxos at that script: ${JSON.stringify(vtxos.map((v) => ({ value: v.value})))}`);
});
