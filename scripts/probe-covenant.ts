/**
 * Derives a per-payment covenant destination from a network's real operator and
 * emulator keys; funds nothing. Failure is silent in production: derivation throws,
 * `server.ts` falls back to the static address, and the flag reads as on while every
 * payer gets the shared one.
 *   pnpm tsx scripts/probe-covenant.ts [arkServerUrl] [covclaimdUrl]
 */
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ArkAddress, getNetwork, resolveEmulatorPubkey, MultisigTapscript, VtxoScript } from "@arkade-os/sdk";
import { deriveCovenantDestination, toXOnly } from "../src/covenant-destination.js";
import { loadConfig } from "../src/config.js";

const arkServerUrl = process.argv[2] ?? "https://mutinynet.arkade.sh";
const covclaimdUrl = process.argv[3] ?? process.env.COVCLAIMD_URL;
const network = (process.env.ARK_NETWORK ?? "mutinynet") as Parameters<typeof getNetwork>[0];

const getJson = async (url: string): Promise<Record<string, unknown>> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
};

const info = await getJson(`${arkServerUrl}/v1/info`);
// Guarded, not stripped: this key builds the static address below, before anything
// inside deriveCovenantDestination would check it, and 31 bytes there produces a
// confusing error instead of "signerPubkey was not a 32- or 33-byte key".
const serverPubkey = toXOnly(hex.decode(String(info.signerPubkey)));

const emulatorHex = covclaimdUrl
  ? String((await getJson(`${covclaimdUrl}/v1/preimage/covclaimd-pubkey`)).emulator_pub_key)
  : String(resolveEmulatorPubkey(getNetwork(network)));

// The delay the deployment would run with, not a chosen one: that is the failure.
const recoveryDelaySeconds = loadConfig({
  ...process.env,
  COVCLAIMD_URL: covclaimdUrl ?? "https://covclaimd.invalid",
  ARK_SERVER_URL: arkServerUrl,
  OFFLINE_COVENANT_DESTINATIONS: "true",
  OFFLINE_EMULATOR_URL: process.env.OFFLINE_EMULATOR_URL ?? "https://emulator.invalid",
}).offlineReceive.covenantRecoveryDelaySeconds;

const userPubkey = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true).subarray(1);
const staticAddress = new VtxoScript([
  MultisigTapscript.encode({ pubkeys: [userPubkey, serverPubkey] }).script,
]).address("tark", serverPubkey).encode();

console.log(`operator   ${arkServerUrl}  signer ${String(info.signerPubkey)}`);
console.log(`emulator   ${emulatorHex}  (${covclaimdUrl ? `from ${covclaimdUrl}` : `pinned for ${network}`})`);
console.log(`delay      ${recoveryDelaySeconds}s  (multiple of 512: ${recoveryDelaySeconds % 512 === 0})`);

const first = deriveCovenantDestination({
  staticAddress, userPubkey, serverPubkey,
  emulatorPubkey: hex.decode(emulatorHex),
  preimage: new Uint8Array(32).fill(7),
  recoveryDelaySeconds,
});
const second = deriveCovenantDestination({
  staticAddress, userPubkey, serverPubkey,
  emulatorPubkey: hex.decode(emulatorHex),
  preimage: new Uint8Array(32).fill(8),
  recoveryDelaySeconds,
});

const staticScript = hex.encode(ArkAddress.decode(staticAddress).pkScript);
const checks: [string, boolean][] = [
  ["address round-trips to its own script", hex.encode(ArkAddress.decode(first.address).pkScript) === first.script],
  ["taptree carries the three leaves", VtxoScript.decode(first.tapTree).scripts.length === 3],
  ["destination differs from the static address", first.script !== staticScript],
  ["a second preimage moves the address", first.script !== second.script],
  ["the covenant bytes stay fixed across payments", hex.encode(first.covenantScript) === hex.encode(second.covenantScript)],
  ["the covenant pins the payout to the static address", hex.encode(first.covenantScript).includes(staticScript.slice(4))],
];

console.log(`\nderived    ${first.address}`);
for (const [what, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);

if (checks.every(([, ok]) => ok)) {
  console.log("\n=> derivation matches this network's keys; the flag would hand out real covenant addresses here.");
  console.log("   Not checked: that this emulator co-signs the sweep — that needs a funded payment.");
} else {
  console.log("\n=> derivation is wrong for this network: every callback would fall back to the static address.");
  process.exitCode = 1;
}
