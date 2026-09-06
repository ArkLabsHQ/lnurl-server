import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ArkAddress, RestIndexerProvider } from "@arkade-os/sdk";
import { createIntentSwapCreator } from "../src/intent-swap.js";
import { payFromCounterparty, counterpartyPayment, pollUntil } from "../test/e2e/support/regtest.js";

async function main() {
  const creator = await createIntentSwapCreator({
    solverUrl: "http://localhost:8787",
    covclaimdUrl: "http://localhost:7271",
    arkServerUrl: "http://localhost:7070",
  });
  const receiveAddress = new ArkAddress(secp256k1.utils.randomSecretKey(), secp256k1.utils.randomSecretKey(), "tark").encode();

  console.log("[1] quoting...");
  const swap = await creator.create({
    amountSat: 5000,
    receiveAddress,
    claimPublicKey: hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)),
  });
  console.log("    invoice:", swap.invoice.slice(0, 50), "…");
  console.log("    lockup :", swap.lockupAddress);
  console.log("    rfqId  :", swap.swapId);

  console.log("[2] paying from counterparty (detached)…");
  const payer = payFromCounterparty(swap.invoice, 900);

  console.log("[3] polling solver rfq status…");
  await pollUntil(
    "solver status != quoted",
    async () => {
      const s = await creator.isSettled(swap.swapId);
      const raw = await fetch(`http://localhost:8787/v1/rfq/${swap.swapId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      console.log("    status:", raw ? JSON.stringify(raw).slice(0, 200) : "(404/null)", "isSettled:", s);
      return s;
    },
    10 * 60_000,
    5000,
  );

  console.log("[4] settled per solver. Payer view:");
  const payment = await counterpartyPayment(swap.preimageHash);
  console.log("   ", JSON.stringify(payment));

  console.log("[5] indexer vtxos at the payout address:");
  const script = hex.encode(ArkAddress.decode(receiveAddress).pkScript);
  const { vtxos } = await new RestIndexerProvider("http://localhost:7070").getVtxos({ scripts: [script] });
  console.log("    vtxos:", vtxos.map((v) => `${v.txid}:${v.vout} value=${v.value} spent=${v.isSpent ?? false}`));

  payer.stop();
  console.log("PROBE COMPLETE");
  process.exit(0);
}
void main();
