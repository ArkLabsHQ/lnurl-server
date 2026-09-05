/**
 * Why a funded lockup never claimed. covclaimd needs a type-4 claim packet AND
 * the output taptree, and declines each at debug level in its own log, so a swap
 * missing either looks exactly like one still waiting.
 */
import { base64, hex } from "@scure/base";
import { Extension, RestIndexerProvider, Transaction } from "@arkade-os/sdk";

const CLAIM_PACKET_TYPE = 0x04;

const txid = process.argv[2];
const arkServerUrl = process.argv[3] ?? process.env.ARK_SERVER_URL ?? "https://mutinynet.arkade.sh";
if (!txid) {
  console.error("usage: pnpm tsx scripts/inspect-funding.ts <txid> [arkServerUrl]");
  process.exit(2);
}

let txs: string[];
try {
  ({ txs } = await new RestIndexerProvider(arkServerUrl).getVirtualTxs([txid]));
} catch (err) {
  console.error(`indexer at ${arkServerUrl} is unreachable: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const raw = txs[0];
if (!raw) {
  console.error(`indexer at ${arkServerUrl} knows no virtual tx ${txid}`);
  process.exit(1);
}
const tx = Transaction.fromPSBT(base64.decode(raw));

let packet: Uint8Array | undefined;
try {
  packet = Extension.fromTx(tx).getPacketByType(CLAIM_PACKET_TYPE)?.serialize();
} catch {
  packet = undefined; // no extension output at all — an unstamped funding
}

console.log(`tx ${txid}`);
console.log(`  outputs: ${tx.outputsLength}`);
for (let i = 0; i < tx.outputsLength; i++) {
  const out = tx.getOutput(i);
  const tapTree = (out as { tapTree?: unknown }).tapTree;
  console.log(`  out[${i}] amount=${out.amount ?? 0n} taptree=${tapTree ? "present" : "ABSENT"}`);
}
if (!packet) {
  console.log(`  claim packet (0x${CLAIM_PACKET_TYPE.toString(16)}): ABSENT — covclaimd can only learn this swap via the Reveal API`);
  process.exit(0);
}
console.log(`  claim packet: ${packet.length} bytes`);
const needle = "030021";
const at = hex.encode(packet).indexOf(needle);
console.log(
  at === -1
    ? "  covclaimd_pub_key (0x03): ABSENT — no covclaimd's filter will select this tx"
    : `  covclaimd_pub_key (0x03): ${hex.encode(packet).slice(at + needle.length, at + needle.length + 66)}`,
);
