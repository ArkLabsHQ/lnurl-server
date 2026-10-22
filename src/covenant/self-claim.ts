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
  type VirtualCoin,
} from "@arkade-os/sdk";
import { LOCKTIME_THRESHOLD } from "@arkade-os/swap/protocol";
import { UpstreamError } from "../errors.js";
import { createLogger, type Logger } from "../logger.js";

export interface SelfClaimRegistration {
  swapId: string;
  /** From `deriveLightningReceive`; also the source of the payout script. */
  script: InstanceType<typeof VHTLC.ScriptV2>;
  /** The quote's `to_amount`, sats — the lockup must carry at least this. */
  expectedAmount: number;
}

export type SelfClaimOutcome =
  | { state: "claimed"; arkTxid: string }
  /** `unregistered` also covers an already-claimed or expired swap: the entry is dropped then. */
  | { state: "skipped"; reason: "unregistered" | "unfunded" | "underfunded" }
  /** `funded`: any VTXO ever reached the lockup. Spent ones count: a solver that reclaimed it was still paid. */
  | { state: "skipped"; reason: "expired"; funded: boolean };

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
    if (!res.ok) throw new UpstreamError(url, res.status);
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

/**
 * The ark tx that already paid a lockup out to `payTo`, if the spend itself proves it.
 *
 * Read from the spend, never from the emulator's reply: arkd can accept the claim and the
 * reply still be lost, and another claimant can get there first. A spend paying anywhere
 * but `payTo` — a solver refund — is no payout, and reporting one would settle the swap
 * and reveal the preimage as proof of a receive that never arrived.
 */
async function observedPayout(
  payTo: Uint8Array | undefined,
  vtxos: readonly VirtualCoin[],
  indexer: IndexerProvider,
): Promise<string | undefined> {
  const arkTxid = vtxos[0]?.arkTxId;
  if (!payTo || !arkTxid || vtxos.some((v) => v.arkTxId !== arkTxid || !v.spentBy)) return undefined;
  const spend = (await indexer.getVirtualTxs([arkTxid])).txs
    .map((psbt) => Transaction.fromPSBT(base64.decode(psbt)))
    .find((tx) => tx.id === arkTxid);
  if (!spend) return undefined;
  for (const vtxo of vtxos) {
    // The covenant pays input i at output i, and the ark tx spends the input's checkpoint.
    let vin = -1;
    for (let i = 0; i < spend.inputsLength && vin < 0; i++) {
      const txid = spend.getInput(i).txid;
      if (txid && hex.encode(txid) === vtxo.spentBy) vin = i;
    }
    if (vin < 0 || vin >= spend.outputsLength) return undefined;
    const output = spend.getOutput(vin);
    if (!output.script || hex.encode(output.script) !== hex.encode(payTo) || (output.amount ?? 0n) < BigInt(vtxo.value)) {
      return undefined;
    }
  }
  return arkTxid;
}

export function createSelfClaimer(opts: {
  arkServerUrl: string;
  emulatorUrl: string;
  arkProvider?: ArkProvider;
  indexer?: IndexerProvider;
  emulator?: EmulatorSubmit;
  logger?: Logger;
}): SelfClaimer {
  const arkProvider = opts.arkProvider ?? new RestArkProvider(opts.arkServerUrl);
  const indexer = opts.indexer ?? new RestIndexerProvider(opts.arkServerUrl);
  const emulator = opts.emulator ?? new RestEmulatorProvider(opts.emulatorUrl);
  const logger = opts.logger ?? createLogger();
  const registry = new Map<string, SelfClaimRegistration>();

  return {
    register(reg) {
      registry.set(reg.swapId, reg);
    },

    async claim(swapId, preimage) {
      const started = performance.now();
      const reg = registry.get(swapId);
      if (!reg) return { state: "skipped", reason: "unregistered" };
      // Publishing P inside the solver's live refund window risks losing the race and giving it
      // away for nothing. A height-typed locktime is not wall clock, so it gates nothing.
      const deadline = reg.script.options.refundLocktime;
      const lockupScript = hex.encode(reg.script.pkScript);
      const payTo = reg.script.options.nonInteractiveParameters?.receiverPkScript;
      // The lockup's whole history, spent included — where a claim that landed is visible.
      const landedPayout = async (): Promise<string | undefined> =>
        observedPayout(payTo, (await indexer.getVtxos({ scripts: [lockupScript] })).vtxos, indexer);
      if (deadline >= BigInt(LOCKTIME_THRESHOLD) && BigInt(Math.floor(Date.now() / 1000)) >= deadline) {
        const { vtxos: ever } = await indexer.getVtxos({ scripts: [lockupScript] });
        registry.delete(swapId);
        // A claim that landed before the deadline still paid the user, however late we see it.
        const paid = await observedPayout(payTo, ever, indexer);
        if (paid) return { state: "claimed", arkTxid: paid };
        return { state: "skipped", reason: "expired", funded: ever.length > 0 };
      }
      const { vtxos } = await indexer.getVtxos({ scripts: [lockupScript], spendableOnly: true });
      const lookupMs = Math.round(performance.now() - started);
      // "Not funded yet" and "already claimed" look alike from the spendable set alone, and
      // only the second owes the payment a payout reference.
      if (vtxos.length === 0) {
        const paid = await landedPayout();
        if (!paid) return { state: "skipped", reason: "unfunded" };
        registry.delete(swapId);
        return { state: "claimed", arkTxid: paid };
      }
      // A sum, not one outpoint: `spendableOnly` dropped what is not live, and this one tx spends all the rest.
      const total = vtxos.reduce((sum, v) => sum + v.value, 0);
      if (total < reg.expectedAmount) return { state: "skipped", reason: "underfunded" };

      const [leaf, arkadeScript] = reg.script.nonInteractiveClaim();
      if (!payTo) throw new Error(`self-claim: registration for ${swapId} carries no nonInteractiveParameters`);
      const packet = EmulatorPacket.create(vtxos.map((_, vin) => ({ vin, script: arkadeScript, witness: RawWitness.encode([]) })));
      let stage = performance.now();
      const info = await arkProvider.getInfo();
      const infoMs = Math.round(performance.now() - stage);
      stage = performance.now();
      const tapTree = reg.script.encode();
      // The covenant checks output[i] against input[i]: one payout per input, in order, packet last.
      const { arkTx, checkpoints } = buildOffchainTx(
        vtxos.map((v) => ({ txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: leaf, tapTree })),
        [...vtxos.map((v) => ({ script: payTo, amount: BigInt(v.value) })), Extension.create([packet]).txOut()],
        CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript)),
      );
      const buildMs = Math.round(performance.now() - stage);
      stage = performance.now();
      // The emulator resolves the spent input's prevout from its creating ark tx.
      await attachPrevArkTxs(arkTx, vtxos.map((v) => v.txid), indexer);
      const prevTxMs = Math.round(performance.now() - stage);
      vtxos.forEach((_, i) => setArkPsbtField(arkTx, i, ConditionWitness, [hex.decode(preimage)]));
      for (const checkpoint of checkpoints) setArkPsbtField(checkpoint, 0, ConditionWitness, [hex.decode(preimage)]);

      stage = performance.now();
      try {
        await emulator.submitTx(
          base64.encode(arkTx.toPSBT()),
          checkpoints.map((c) => base64.encode(c.toPSBT())),
        );
      } catch (error) {
        // The emulator can hang and then fail with arkd already holding the tx.
        let landed: string | undefined;
        try { landed = await landedPayout(); } catch { /* the emulator's failure is the one worth reporting */ }
        if (!landed) throw error;
        registry.delete(swapId);
        return { state: "claimed", arkTxid: landed };
      }
      const submitMs = Math.round(performance.now() - stage);
      logger.info("offline_swap_self_claim_timing", {
        swapRef: swapId.slice(0, 12), lookupMs, infoMs, buildMs, prevTxMs, submitMs,
        totalMs: Math.round(performance.now() - started), inputs: vtxos.length,
      });
      registry.delete(swapId);
      // Not read back from the reply: a txid commits to no witness data, so the
      // emulator's signatures cannot change it. Sound while this input stays
      // taproot-only — a scriptSig one could gain a finalScriptSig server-side.
      return { state: "claimed", arkTxid: arkTx.id };
    },
  };
}
