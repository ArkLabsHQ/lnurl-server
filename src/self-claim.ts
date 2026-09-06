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
      if (vtxos.length === 0) return { state: "skipped", reason: "unfunded" };
      const vtxo = vtxos[0]!;
      const funded = vtxos.reduce((sum, v) => sum + v.value, 0);
      // The solver settles the payer's invoice off the preimage, not off what it funded.
      if (funded < reg.expectedAmount) return { state: "skipped", reason: "underfunded" };

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
