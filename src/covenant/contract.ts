// The per-payment covenant as an SDK contract type, so the ContractManager can track,
// watch and spend it the way it does its own. Registering a handler is what buys the
// subscription-backed watcher, the awaiting-funds lifecycle and path selection — none
// of which we then maintain ourselves.

import { hex } from "@scure/base";
import { getSequence, VtxoScript, type Contract, type ContractHandler, type PathSelection } from "@arkade-os/sdk";
import { COLLABORATIVE_LEAF, COVENANT_V1, RECOVERY_LEAF, RENEW_LEAF, SWEEP_LEAF, covenantVtxoScript } from "./destination.js";

export const COVENANT_CONTRACT_TYPE = "lnurl-covenant-destination";

export interface CovenantContractParams {
  staticAddress: string;
  userPubkey: Uint8Array;
  serverPubkey: Uint8Array;
  emulatorPubkey: Uint8Array;
  preimage: Uint8Array;
  recoveryDelaySeconds: number;
  /** Which covenant construction these params build. Absent on disk means v1 —
   *  see deserialize; a stored row predates versioning and must never move. */
  version: number;
}

const serialize = (p: CovenantContractParams): Record<string, string> => ({
  staticAddress: p.staticAddress,
  userPubkey: hex.encode(p.userPubkey),
  serverPubkey: hex.encode(p.serverPubkey),
  emulatorPubkey: hex.encode(p.emulatorPubkey),
  preimage: hex.encode(p.preimage),
  recoveryDelaySeconds: String(p.recoveryDelaySeconds),
  version: String(p.version),
});

const deserialize = (p: Record<string, string>): CovenantContractParams => ({
  staticAddress: p.staticAddress!,
  userPubkey: hex.decode(p.userPubkey!),
  serverPubkey: hex.decode(p.serverPubkey!),
  emulatorPubkey: hex.decode(p.emulatorPubkey!),
  preimage: hex.decode(p.preimage!),
  recoveryDelaySeconds: Number(p.recoveryDelaySeconds),
  // The load-bearing default: rows written before versioning carry no key, and
  // their money sits at an address only the v1 bytes reproduce.
  version: p.version === undefined ? COVENANT_V1 : Number(p.version),
});

const pathsFor = (script: VtxoScript, contract: Contract): PathSelection[] => {
  const { preimage } = deserialize(contract.params);
  const leaves = script.leaves;
  const recovery = leaves[RECOVERY_LEAF]!;
  // Read off the leaf rather than recomputed from params: the sequence has to match
  // the script that is actually being spent, not what we believe we encoded.
  const sequence = getSequence(recovery);
  return [
    { leaf: leaves[SWEEP_LEAF]!, extraWitness: [preimage] },
    { leaf: leaves[COLLABORATIVE_LEAF]! },
    { leaf: recovery, ...(sequence === undefined ? {} : { sequence }) },
    ...(leaves[RENEW_LEAF] ? [{ leaf: leaves[RENEW_LEAF] }] : []),
  ];
};

/** The SDK's `TapscriptDeriving` capability, restated because it is not exported by
 *  name from the package root. Structural, so it keeps matching if that changes. */
interface DerivesTapscripts {
  deriveTapscripts(
    script: VtxoScript,
    contract: Contract,
  ): {
    forfeitTapLeafScript: VtxoScript["leaves"][number];
    intentTapLeafScript: VtxoScript["leaves"][number];
    tapTree: Uint8Array;
  };
}

export const covenantDestinationHandler: ContractHandler<CovenantContractParams, VtxoScript> & DerivesTapscripts = {
  type: COVENANT_CONTRACT_TYPE,

  /** v3 batch proofs use renewal; older contracts require the user's collaborative leaf. */
  deriveTapscripts: (script) => ({
    forfeitTapLeafScript: script.leaves[RENEW_LEAF] ?? script.leaves[COLLABORATIVE_LEAF]!,
    intentTapLeafScript: script.leaves[RENEW_LEAF] ?? script.leaves[COLLABORATIVE_LEAF]!,
    tapTree: script.encode(),
  }),

  createScript: (params) => covenantVtxoScript(deserialize(params)).vtxo,
  serializeParams: serialize,
  deserializeParams: deserialize,

  getAllSpendingPaths: (script, contract) => pathsFor(script, contract),

  /** The recovery leaf is the user's alone and only after its CSV; the other paths need
   *  a counterparty that is online now, which `collaborative` is exactly asking about. */
  getSpendablePaths(script, contract, context): PathSelection[] {
    const [sweep, collaborative, recovery, renew] = pathsFor(script, contract);
    const fundedAt = context.vtxo?.status.block_time;
    const nowSeconds = Math.floor(context.chainTime ?? context.currentTime / 1000);
    const out: PathSelection[] = [];
    if (context.collaborative) {
      out.push(sweep!, collaborative!);
      if (renew) out.push(renew);
    }
    // CSV is relative to this VTXO's confirmation, never contract creation. If
    // that anchor is unavailable, withholding recovery is the only safe answer.
    if (fundedAt !== undefined && nowSeconds - fundedAt >= deserialize(contract.params).recoveryDelaySeconds) out.push(recovery!);
    return out;
  },

  /** The sweep leaf: the only one this service can complete, since it holds the
   *  preimage and the emulator co-signs against the covenant. */
  selectPath: (script, contract, context) =>
    context.collaborative ? pathsFor(script, contract)[SWEEP_LEAF]! : null,

  /** Never picked up by generic wallet spending: these outputs are swept to the
   *  user's registered address by the covenant and belong to no wallet's balance. */
  isGenericallySpendable: () => false,
};
