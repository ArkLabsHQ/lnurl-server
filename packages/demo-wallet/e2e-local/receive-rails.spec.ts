// The four receive rails offline-receive.spec.ts leaves out, against the same
// local stack. The browser is deliberately absent: the demo wallet opens no
// session and has no Lightning node, so the receiver half here is the client
// package — the same one the wallet ships — driving the same real server.
import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { bech32, hex } from "@scure/base";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ArkAddress, MnemonicIdentity, RestIndexerProvider, Wallet } from "@arkade-os/sdk";
import { createLnurlClient, type PayRequest } from "@arkade-os/lnurl-client";
import {
  ESPLORA_URL,
  counterpartyPayment,
  faucet,
  lncli,
  mine,
  nodeSqliteStorage,
  payFromCounterparty,
  pollUntil,
} from "../../../test/e2e/support/regtest.js";
import {
  CARDS_FILE,
  STATE_DIR,
  readLocalStack,
  startLnurlServer,
  type LnurlServerHandle,
  type LocalStack,
} from "./local-stack.js";

/** The pair after the global setup's 4283/4284: a second server, same stack. */
const COVENANT_PORT = 4285;
const COVENANT_ADMIN_PORT = 4286;

const INTERACTIVE_SATS = 1500;
const ARKADE_SATS = 2100;
const COVENANT_SATS = 3300;
// Above ONCHAIN_MIN_SENDABLE_SATS: the onchain rail's floor is economic, not
// dust, because delivering it costs the payer a Bitcoin fee.
const ONCHAIN_SATS = 12_000;
const SETTLE_TIMEOUT_MS = 3 * 60_000;

const payer = createLnurlClient();
const sha256Hex = (hexInput: string) => createHash("sha256").update(Buffer.from(hexInput, "hex")).digest("hex");
const name = (prefix: string) => `${prefix}${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

interface User {
  wallet: Wallet;
  arkadeAddress: string;
  boardingAddress: string;
  claimPublicKey: string;
}

async function newWallet(): Promise<{ wallet: Wallet; identity: MnemonicIdentity }> {
  const identity = MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist), { isMainnet: false });
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: stack.arkServer,
    esploraUrl: ESPLORA_URL,
    storage: await nodeSqliteStorage(":memory:"),
    settlementConfig: false,
  });
  return { wallet, identity };
}

/** A receiving identity the server can register. Unfunded: only the payer needs coins. */
async function newUser(): Promise<User> {
  const { wallet, identity } = await newWallet();
  return {
    wallet,
    arkadeAddress: await wallet.getAddress(),
    boardingAddress: await wallet.getBoardingAddress(),
    claimPublicKey: hex.encode(await identity.compressedPublicKey()),
  };
}

/** The payer these rails are missing otherwise: a wallet with spendable VTXOs. */
async function fundedPayer(): Promise<Wallet> {
  const { wallet } = await newWallet();
  await faucet(await wallet.getBoardingAddress(), "0.002");
  await mine(1);
  // arkd needs to see the confirmed deposit before it is a valid settle input.
  for (let attempt = 1; ; attempt++) {
    try {
      await wallet.settle();
      break;
    } catch (err) {
      if (!String(err instanceof Error ? err.message : err).includes("No inputs found") || attempt >= 15) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await mine(1);
  return wallet;
}

async function register(base: string, username: string, user: User, opts?: { boarding?: boolean }) {
  const token = randomBytes(32).toString("hex");
  const owner = createLnurlClient({ baseUrl: base });
  await owner.registerAddress({ token, username });
  await owner.registerArkadeIdentity({
    token,
    username,
    arkadeAddress: user.arkadeAddress,
    claimPublicKey: user.claimPublicKey,
    ...(opts?.boarding ? { boardingAddress: user.boardingAddress } : {}),
  });
  return { token, owner };
}

/** The advertised callback carries the address's domain, and a LUD-16 domain
 *  cannot name a port — so re-origin it rather than teach the server to
 *  advertise one it would not advertise behind a proxy. */
async function payRequestFor(base: string, username: string): Promise<PayRequest> {
  const url = `${base}/.well-known/lnurlp/${username}`;
  const lnurl = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 1023);
  const payRequest = await payer.resolve(lnurl);
  const { hostname, host } = new URL(base);
  return { ...payRequest, callback: payRequest.callback.replace(hostname, host) };
}

let stack: LocalStack;
let payerWallet: Wallet;
const opened: Wallet[] = [];

test.beforeAll(async () => {
  stack = readLocalStack();
  payerWallet = await fundedPayer();
  opened.push(payerWallet);
});

test.afterAll(async () => {
  for (const wallet of opened) await wallet.dispose().catch(() => undefined);
});

test("interactive lightning: the live session's own BOLT11 reaches the payer and really settles", async () => {
  const user = await newUser();
  opened.push(user.wallet);
  const username = name("int");
  // Registered with an Arkade identity: the offline swap would serve this
  // address, and the live session is what takes precedence over it.
  const { token, owner } = await register(stack.lnurlBase, username, user);

  const preimage = randomBytes(32).toString("hex");
  const paymentHash = sha256Hex(preimage);
  const minted = await lncli<{ payment_request: string }>("lnd", [
    "addinvoice", "--amt", String(INTERACTIVE_SATS), "--preimage", preimage,
  ]);

  const requested: number[] = [];
  const session = await owner.openSession({ token }, {
    onInvoiceRequest: (req, respond) => {
      requested.push(req.amountMsat);
      void respond.answerInvoice(minted.payment_request);
    },
  });

  try {
    const payRequest = await payRequestFor(stack.lnurlBase, username);
    const result = await payer.requestInvoice(payRequest, { amountSat: INTERACTIVE_SATS });
    if (result.kind !== "bolt11") throw new Error(`expected a bolt11, got ${result.kind}`);
    // Byte for byte the session's answer, not a solver hold invoice.
    expect(result.pr).toBe(minted.payment_request);
    expect(requested).toEqual([INTERACTIVE_SATS * 1000]);
    expect(result.verify).toBeTruthy();

    const paying = payFromCounterparty(result.pr);
    try {
      await pollUntil(
        "counterparty payment",
        async () => (await counterpartyPayment(paymentHash))?.status === "SUCCEEDED",
        120_000,
        2000,
      );
    } finally {
      paying.stop();
    }

    // The receiving node settled it; the wallet reporting that preimage is the
    // only settlement signal a relay with no Lightning node can have.
    const held = await lncli<{ state: string }>("lnd", ["lookupinvoice", paymentHash]);
    expect(held.state).toBe("SETTLED");
    await session.reportSettled(preimage);

    const status = await payer.pollVerify(result.verify!, { timeoutMs: 30_000, intervalMs: 1000 });
    expect(status).toMatchObject({ kind: "bolt11", settled: true, preimage });
  } finally {
    session.close();
  }
});

test("arkade rail, static destination: the user's own address, no verify, settled by observation", async () => {
  const user = await newUser();
  opened.push(user.wallet);
  const username = name("ark");
  const { token, owner } = await register(stack.lnurlBase, username, user);

  // objectContaining, not the bare pair: against a real solver card the swap rail
  // narrows the lightning bounds, so arkade publishes the wider envelope it can
  // still honour rather than inheriting the top-level pair.
  const payRequest = await payRequestFor(stack.lnurlBase, username);
  expect(payRequest.paymentOptions).toContainEqual(expect.objectContaining({ id: "arkade", type: "arkade" }));

  const result = await payer.requestInvoice(payRequest, { amountSat: ARKADE_SATS, paymentOption: "arkade" });
  expect(result).toEqual({ kind: "destination", paymentOption: "arkade", paymentDestination: user.arkadeAddress });
  // One address reused for every payment settles by amount/window correlation,
  // so the server hands out no verify it could not stand behind.
  expect("verify" in result).toBe(false);

  const txid = await payerWallet.sendBitcoin({ address: user.arkadeAddress, amount: ARKADE_SATS });
  expect(txid).toMatch(/^[0-9a-f]{64}$/);
  await pollUntil(
    "the arkade watcher settles the record",
    async () => {
      const page = await owner.listPayments(token, username);
      return page.payments.some((p) => p.kind === "destination" && p.settled && p.paymentReference === txid);
    },
    SETTLE_TIMEOUT_MS,
    3000,
  );
});

test("onchain rail: the boarding address, no verify, and no settlement even once it is funded", async () => {
  const user = await newUser();
  opened.push(user.wallet);
  const username = name("onc");
  const { token, owner } = await register(stack.lnurlBase, username, user, { boarding: true });

  const payRequest = await payRequestFor(stack.lnurlBase, username);
  expect(payRequest.paymentOptions).toContainEqual(expect.objectContaining({ id: "onchain", type: "onchain" }));

  const result = await payer.requestInvoice(payRequest, { amountSat: ONCHAIN_SATS, paymentOption: "onchain" });
  expect(result).toEqual({ kind: "destination", paymentOption: "onchain", paymentDestination: user.boardingAddress });
  expect("verify" in result).toBe(false);

  // Nothing here watches Bitcoin, so settlement is not provable locally — what
  // is provable is the negative: a real onchain payment to the advertised
  // address, confirmed, and the record still does not flip. Two watcher ticks.
  await faucet(user.boardingAddress, (ONCHAIN_SATS / 1e8).toFixed(8));
  await mine(1);
  await new Promise((r) => setTimeout(r, 35_000));

  const page = await owner.listPayments(token, username);
  const record = page.payments.find((p) => p.kind === "destination" && p.paymentOption === "onchain");
  expect(record).toMatchObject({ settled: false, paymentReference: null, paymentDestination: user.boardingAddress });
});

// A second server rather than a second stack: covenant destinations are a
// process-level flag, and the stack is a singleton with one solver float.
test.describe("arkade rail, per-payment covenant destinations", () => {
  let server: LnurlServerHandle;

  test.beforeAll(async () => {
    server = await startLnurlServer({
      port: COVENANT_PORT,
      adminPort: COVENANT_ADMIN_PORT,
      dbPath: join(STATE_DIR, "lnurl-covenant.sqlite"),
      cardsFile: CARDS_FILE,
      logName: "lnurl-covenant.log",
      env: { OFFLINE_COVENANT_DESTINATIONS: "true" },
    });
  });

  test.afterAll(async () => {
    await server?.stop();
  });

  test("an address per quote, a verify the server can honour, then a sweep to the user", async () => {
    const user = await newUser();
    opened.push(user.wallet);
    const username = name("cov");
    await register(server.base, username, user);

    const payRequest = await payRequestFor(server.base, username);
    const quote = async () => {
      const result = await payer.requestInvoice(payRequest, { amountSat: COVENANT_SATS, paymentOption: "arkade" });
      if (result.kind !== "destination") throw new Error(`expected a destination, got ${result.kind}`);
      return result;
    };
    const first = await quote();
    const second = await quote();

    expect(first.paymentDestination).not.toBe(user.arkadeAddress);
    expect(second.paymentDestination).not.toBe(first.paymentDestination);
    // The script identifies the payment, so this verify is one the server can answer.
    expect(first.verify).toMatch(/\/lnurl\/verify\/[0-9a-f]{32}$/);
    expect(second.verify).toMatch(/\/lnurl\/verify\/[0-9a-f]{32}$/);

    const txid = await payerWallet.sendBitcoin({ address: second.paymentDestination!, amount: COVENANT_SATS });
    const settled = await payer.pollVerify(second.verify!, { timeoutMs: SETTLE_TIMEOUT_MS, intervalMs: 3000 });
    expect(settled).toMatchObject({
      kind: "destination",
      settled: true,
      paymentReference: txid,
      paymentDestination: second.paymentDestination,
    });

    // What the script buys over amount-and-window correlation: the unpaid quote
    // of the SAME amount to the same receiver is untouched.
    const unpaid = await (await fetch(first.verify!)).json() as { settled: boolean };
    expect(unpaid.settled).toBe(false);

    const indexer = new RestIndexerProvider(stack.arkServer);
    const staticScript = hex.encode(ArkAddress.decode(user.arkadeAddress).pkScript);
    await pollUntil(
      "sweep to the registered address",
      async () => {
        const { vtxos } = await indexer.getVtxos({ scripts: [staticScript], spendableOnly: true });
        return vtxos.some((v) => v.value === COVENANT_SATS);
      },
      SETTLE_TIMEOUT_MS,
      3000,
    );
  });
});
