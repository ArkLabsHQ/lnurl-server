import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ArkAddress } from "@arkade-os/sdk";
import { createIntentSwapCreator } from "../src/intent-swap.js";
import { payFromCounterparty, counterpartyPayment, pollUntil, mine } from "../test/e2e/support/regtest.js";

async function main() {
  const creator = await createIntentSwapCreator({
    solverUrl: "http://localhost:8787",
    covclaimdUrl: "http://localhost:7271",
    arkServerUrl: "http://localhost:7070",
  });
  const receiveAddress = new ArkAddress(secp256k1.utils.randomSecretKey(), secp256k1.utils.randomSecretKey(), "tark").encode();

  console.log("[1] quoting…");
  const swap = await creator.create({
    amountSat: 5000,
    receiveAddress,
    claimPublicKey: hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)),
  });
  console.log("    rfqId:", swap.swapId.slice(0, 16), "hash:", swap.preimageHash.slice(0, 16));

  console.log("[2] paying (background)…");
  const payer = payFromCounterparty(swap.invoice, 900);

  console.log("[3] watching solver state (mining once the lockup is funded)…");
  let mined = false;
  let finalState = "";
  await pollUntil(
    "settled",
    async () => {
      const raw = await fetch(`http://localhost:8787/v1/rfq/${swap.swapId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const state = raw?.state ?? "?";
      if (state !== finalState) console.log("    state:", state);
      finalState = state;
      if ((state === "funded" || state === "claimed") && !mined) {
        mined = true;
        console.log("    funded — mining 2 blocks so the claim's prevout exists on-chain…");
        await mine(2);
      }
      return state === "settled";
    },
    8 * 60_000,
    3000,
  );

  const payment = await counterpartyPayment(swap.preimageHash);
  console.log("[4] payer:", payment?.status, "preimage match:", payment?.payment_preimage === swap.preimage);
  payer.stop();
  console.log("PROBE COMPLETE");
  process.exit(0);
}
void main();
