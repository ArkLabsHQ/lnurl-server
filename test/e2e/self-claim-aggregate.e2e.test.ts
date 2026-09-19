/**
 * E2E: does a real arkd + emulator accept a self-claim spending SEVERAL lockup
 * outputs at once? The unit tests echo — their emulator never evaluates
 * `enforcePayTo`, so they pin the transaction's shape and not whether the covenant
 * admits it, which turns on `output[i]`/`input[i]` alignment per spent input.
 *
 * Needs offline-receive.e2e.test.ts's stack plus the emulator. Run: `pnpm test:e2e`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  MnemonicIdentity,
  RestArkProvider,
  RestIndexerProvider,
  Wallet,
  getNetwork,
  toXOnly,
  type NetworkName,
} from "@arkade-os/sdk";
import { paymentHashOf, receiveVtxoScript, unilateralClaimDelay } from "@arkade-os/swap";
import { createSelfClaimer } from "../../src/self-claim.js";
import { ensureStack, pollUntil, mine, faucet, nodeSqliteStorage, ARKD_URL, EMULATOR_URL } from "./support/regtest.js";

const FIRST_SATS = 2_000;
const SECOND_SATS = 3_000;
const EXPECTED_SATS = FIRST_SATS + SECOND_SATS;
const SETUP_TIMEOUT_MS = 30 * 60_000;
const CLAIM_TIMEOUT_MS = 5 * 60_000;

const log = (s: string) => console.log(s);

async function fundedWallet(): Promise<Wallet> {
  const wallet = await Wallet.create({
    identity: MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist), { isMainnet: false }),
    arkServerUrl: ARKD_URL,
    storage: await nodeSqliteStorage(":memory:"),
    settlementConfig: false,
  });
  const boarding = await wallet.getBoardingAddress();
  log(`[setup] fauceting payer boarding ${boarding.slice(0, 18)}…`);
  await faucet(boarding, "0.002");
  await mine(1);
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

describe("e2e: self-claim aggregates a piecemeal-funded lockup", () => {
  let payer: Wallet;
  let indexer: RestIndexerProvider;
  let claimer: ReturnType<typeof createSelfClaimer>;
  let script: ReturnType<typeof receiveVtxoScript>;
  let lockupAddress: string;
  let payoutScriptHex: string;
  let preimageHex: string;
  const swapId = `agg-${hex.encode(randomBytes(8))}`;

  beforeAll(async () => {
    await ensureStack(log);
    indexer = new RestIndexerProvider(ARKD_URL);
    payer = await fundedWallet();

    const info = await new RestArkProvider(ARKD_URL).getInfo();
    const emulatorInfo = (await (await fetch(`${EMULATOR_URL}/v1/info`)).json()) as { signerPubkey: string };
    const hrp = getNetwork(info.network as NetworkName).hrp;

    const preimage = randomBytes(32);
    preimageHex = hex.encode(preimage);
    const key = () => secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true).slice(1);
    const payoutPubkey = key();
    const payoutPkScript = new Uint8Array([0x51, 0x20, ...payoutPubkey]);
    payoutScriptHex = hex.encode(payoutPkScript);

    script = receiveVtxoScript({
      solverPubkey: key(),
      // Wall-clock typed and well ahead: a height locktime leaves the deadline gate
      // disarmed, which would make this test pass for the wrong reason.
      refundLocktime: Math.floor(Date.now() / 1000) + 7_200,
      serverPubkey: toXOnly(hex.decode(info.signerPubkey), "ark signer key"),
      paymentHash: paymentHashOf(preimage),
      claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
      emulatorPubkey: toXOnly(hex.decode(emulatorInfo.signerPubkey), "emulator signer key"),
      solverRefundPkScript: new Uint8Array([0x51, 0x20, ...key()]),
      payoutPubkey,
      payoutPkScript,
    });
    lockupAddress = script.address(hrp, script.options.server).encode();
    claimer = createSelfClaimer({ arkServerUrl: ARKD_URL, emulatorUrl: EMULATOR_URL });
    claimer.register({ swapId, script, expectedAmount: EXPECTED_SATS });
    log(`[setup] lockup ${lockupAddress.slice(0, 22)}… expecting ${EXPECTED_SATS} sats`);
  }, SETUP_TIMEOUT_MS);

  const lockupVtxoCount = async (): Promise<number> => {
    const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(script.pkScript)], spendableOnly: true });
    return vtxos.length;
  };

  it(
    "refuses one short output, then claims both in a single transaction",
    async () => {
      await payer.sendBitcoin({ address: lockupAddress, amount: FIRST_SATS });
      await pollUntil("first lockup output", async () => (await lockupVtxoCount()) >= 1, 60_000);

      // Short of the quote: the preimage must not be published for it.
      const short = await claimer.claim(swapId, preimageHex);
      expect(short).toEqual({ state: "skipped", reason: "underfunded" });
      expect(await lockupVtxoCount()).toBe(1);

      await payer.sendBitcoin({ address: lockupAddress, amount: SECOND_SATS });
      await pollUntil("second lockup output", async () => (await lockupVtxoCount()) >= 2, 60_000);

      const claimed = await claimer.claim(swapId, preimageHex);
      expect(claimed).toMatchObject({ state: "claimed" });
      log(`[claim] arkTxid ${(claimed as { arkTxid: string }).arkTxid}`);

      // The covenant pinned every payout to this script; nothing else could receive it.
      await pollUntil(`${EXPECTED_SATS} sats at the payout script`, async () => {
        const { vtxos } = await indexer.getVtxos({ scripts: [payoutScriptHex], spendableOnly: true });
        return vtxos.reduce((sum, v) => sum + v.value, 0) === EXPECTED_SATS;
      }, 120_000);

      await pollUntil("lockup fully spent", async () => (await lockupVtxoCount()) === 0, 120_000);
    },
    CLAIM_TIMEOUT_MS,
  );
});
