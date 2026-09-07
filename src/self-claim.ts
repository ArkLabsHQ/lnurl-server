// Server-side push of the lockup's `nonInteractiveClaim` leaf (OFFLINE_SELF_CLAIM):
// operator + an emulator key tweaked by `enforcePayTo(receiverPkScript)`, gated on
// the preimage we generated. We hold neither signing key, so we cannot redirect it.
//
// NOT the collaborative `claim` leaf: that one is a bare preimage + receiver +
// operator multisig with no output constraint, so spending it would make this
// server custodial for every in-flight swap.

import { base64, hex } from "@scure/base";
import { RawWitness } from "@scure/btc-signer";
import {
  ConditionWitness,
  CSVMultisigTapscript,
  EmulatorPacket,
  Extension,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  Transaction,
  attachPrevArkTxs,
  buildOffchainTx,
  setArkPsbtField,
  type ArkProvider,
  type IndexerProvider,
  type VHTLC,
} from "@arkade-os/sdk";

export interface SelfClaimRegistration {
  swapId: string;
  /** From `deriveLightningReceive`; also the source of the payout script. */
  script: InstanceType<typeof VHTLC.ScriptV2>;
  /** The quote's `to_amount`, sats — the lockup must carry at least this. */
  expectedAmount: number;
}

export type SelfClaimOutcome =
  | { state: "claimed"; arkTxid: string }
  /** `unregistered` also covers an already-claimed swap: the entry is dropped on success. */
  | { state: "skipped"; reason: "unregistered" | "unfunded" | "underfunded" };

interface EmulatorSubmit {
  submitTx(arkTx: string, checkpointTxs: string[]): Promise<{ signedArkTx: string; signedCheckpointTxs: string[] }>;
}

export interface SelfClaimer {
  register(reg: SelfClaimRegistration): void;
  claim(swapId: string, preimage: string): Promise<SelfClaimOutcome>;
}

export type EmulatorPairing = "matched" | "mismatched" | "unknown";

/**
 * Loud at boot rather than silent per-claim. The covenant bakes in the emulator
 * key covclaimd reports, so an `OFFLINE_EMULATOR_URL` naming a different signer
 * yields covenants nobody can satisfy — and the first sign of it would otherwise
 * be a funded lockup that never claims.
 *
 * Never throws and never blocks startup: unreachable is `unknown`, because a
 * transient blip at boot is a worse reason to refuse to serve than the
 * misconfiguration this catches.
 */
export async function checkEmulatorPairing(opts: {
  covclaimdUrl: string;
  emulatorUrl: string;
  warn?: (message: string) => void;
}): Promise<EmulatorPairing> {
  const warn = opts.warn ?? console.warn;
  const get = async (url: string) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  let expected: string;
  let signer: string;
  let deprecated: string[];
  try {
    expected = String((await get(`${opts.covclaimdUrl}/v1/preimage/covclaimd-pubkey`)).emulator_pub_key ?? "");
    const info = await get(`${opts.emulatorUrl}/v1/info`);
    signer = String(info.signerPubkey ?? "");
    deprecated = Array.isArray(info.deprecatedSignerPubkeys) ? info.deprecatedSignerPubkeys.map(String) : [];
  } catch {
    return "unknown";
  }
  // A 200 carrying no key teaches nothing about the pairing, so say so rather
  // than reporting a disagreement between a key and a blank.
  if (!expected || !signer) return "unknown";
  // A rotated emulator still satisfies covenants built under its old key.
  if ([signer, ...deprecated].includes(expected)) return "matched";
  warn(
    `offline self-claim: OFFLINE_EMULATOR_URL signs with ${signer}, but covclaimd's covenants name ` +
      `${expected} — every self-claim will fail until they agree`,
  );
  return "mismatched";
}

export function createSelfClaimer(opts: {
  arkServerUrl: string;
  emulatorUrl: string;
  arkProvider?: ArkProvider;
  indexer?: IndexerProvider;
  emulator?: EmulatorSubmit;
}): SelfClaimer {
  const arkProvider = opts.arkProvider ?? new RestArkProvider(opts.arkServerUrl);
  const indexer = opts.indexer ?? new RestIndexerProvider(opts.arkServerUrl);
  const emulator = opts.emulator ?? new RestEmulatorProvider(opts.emulatorUrl);
  const registry = new Map<string, SelfClaimRegistration>();

  return {
    register(reg) {
      registry.set(reg.swapId, reg);
    },

    async claim(swapId, preimage) {
      const reg = registry.get(swapId);
      if (!reg) return { state: "skipped", reason: "unregistered" };
      const lockupScript = hex.encode(reg.script.pkScript);
      const { vtxos } = await indexer.getVtxos({ scripts: [lockupScript], spendableOnly: true });
      // "Not funded yet" and "already spent" are the same no-op: retries are safe.
      if (vtxos.length !== 1) return { state: "skipped", reason: "unfunded" };
      const vtxo = vtxos[0]!;
      // The outpoint spent, never a sum across outpoints: the preimage buys THIS one.
      if (vtxo.value < reg.expectedAmount) return { state: "skipped", reason: "underfunded" };

      const [leaf, arkadeScript] = reg.script.nonInteractiveClaim();
      const payTo = reg.script.options.nonInteractiveParameters!.receiverPkScript;
      const packet = EmulatorPacket.create([{ vin: 0, script: arkadeScript, witness: RawWitness.encode([]) }]);
      const info = await arkProvider.getInfo();
      // The covenant checks the output at the SPENT INPUT's index: payout stays 0.
      const { arkTx, checkpoints } = buildOffchainTx(
        [{ txid: vtxo.txid, vout: vtxo.vout, value: vtxo.value, tapLeafScript: leaf, tapTree: reg.script.encode() }],
        [{ script: payTo, amount: BigInt(vtxo.value) }, Extension.create([packet]).txOut()],
        CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript)),
      );
      // The emulator resolves the spent input's prevout from its creating ark tx.
      await attachPrevArkTxs(arkTx, [vtxo.txid], indexer);
      setArkPsbtField(arkTx, 0, ConditionWitness, [hex.decode(preimage)]);
      setArkPsbtField(checkpoints[0]!, 0, ConditionWitness, [hex.decode(preimage)]);

      const res = await emulator.submitTx(
        base64.encode(arkTx.toPSBT()),
        checkpoints.map((c) => base64.encode(c.toPSBT())),
      );
      registry.delete(swapId);
      return { state: "claimed", arkTxid: Transaction.fromPSBT(base64.decode(res.signedArkTx)).id };
    },
  };
}
