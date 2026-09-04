/**
 * Live probe of the offline-receive corridor: request a real `lightning:BTC->arkade:BTC`
 * quote from a deployed solver over Nostr and run the full client-side verification
 * (quote amounts, hold-invoice binding, covenant address match). Nothing is funded —
 * the invoice is never paid and the quote simply expires.
 *
 *   pnpm tsx scripts/probe-solver.ts [solverPubkey] [relay] [arkServerUrl]
 *
 * Defaults target the mutinynet registry's ln-solver-mutinynet card.
 * covclaimd's pubkey endpoint is faked locally: the claim packet is a blind field in
 * the quote path, but the emulator key must be the network's real pin or the covenant
 * derivation won't match the solver's.
 */
import http from "node:http";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ArkAddress, getNetwork, resolveEmulatorPubkey } from "@arkade-os/sdk";
import { createIntentSwapCreator } from "../src/intent-swap.js";

const solverPubkey = process.argv[2] ?? "3f831510a6d7678d0c90d7d6fbc4057720517e2e30681ef4c87cc57aaf57e8d5";
const relay = process.argv[3] ?? "wss://nostr.arkade.sh";
const arkServerUrl = process.argv[4] ?? "https://mutinynet.arkade.sh";

const dummyCovclaimdKey = hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
const emulatorKey = resolveEmulatorPubkey(getNetwork("mutinynet"));

const covclaimd = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/v1/preimage/covclaimd-pubkey") {
    res.end(JSON.stringify({ covclaimd_pub_key: dummyCovclaimdKey, emulator_pub_key: emulatorKey }));
  } else {
    res.statusCode = 404;
    res.end("{}");
  }
});

await new Promise<void>((r) => covclaimd.listen(0, "127.0.0.1", r));
const covclaimdUrl = `http://127.0.0.1:${(covclaimd.address() as { port: number }).port}`;

console.log(`solver   ${solverPubkey}`);
console.log(`relay    ${relay}`);
console.log(`operator ${arkServerUrl}`);

const creator = createIntentSwapCreator({ solverPubkey, nostrRelays: [relay], covclaimdUrl, arkServerUrl });
const receiveAddress = new ArkAddress(secp256k1.utils.randomSecretKey(), secp256k1.utils.randomSecretKey(), "tark").encode();
const claimPublicKey = hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));

try {
  const swap = await creator.create({ amountSat: 2000, receiveAddress, claimPublicKey });
  console.log("\nQUOTE ACCEPTED — full client-side verification passed:");
  console.log(`  rfqId         ${swap.swapId}`);
  console.log(`  invoice       ${swap.invoice.slice(0, 60)}…`);
  console.log(`  preimageHash  ${swap.preimageHash}`);
  console.log(`  lockupAddress ${swap.lockupAddress}`);
  console.log("\n=> the receive corridor is served and the wire contract matches the vendored client.");
  process.exitCode = 0;
} catch (err) {
  console.log(`\nquote failed: ${err instanceof Error ? err.message : String(err)}`);
  console.log("=> transport works if the error is a structured refusal (SwapRefusal); a timeout means unreachable.");
  process.exitCode = 1;
} finally {
  covclaimd.close();
  // The Nostr pool's sockets would otherwise hold the event loop open.
  process.exit(process.exitCode ?? 0);
}
