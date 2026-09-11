// The per-payment covenant as an SDK contract type, so the ContractManager can track,
// watch and spend it the way it does its own. Registering a handler is what buys the
// subscription-backed watcher, the awaiting-funds lifecycle and path selection — none
// of which we then maintain ourselves.

import { hex } from "@scure/base";
import { getSequence, VtxoScript, type Contract, type ContractHandler, type PathSelection } from "@arkade-os/sdk";
import { COLLABORATIVE_LEAF, RECOVERY_LEAF, SWEEP_LEAF, covenantVtxoScript } from "./covenant-destination.js";

export const COVENANT_CONTRACT_TYPE = "lnurl-covenant-destination";

export interface CovenantContractParams {
  staticAddress: string;
  userPubkey: Uint8Array;
  serverPubkey: Uint8Array;
  emulatorPubkey: Uint8Array;
  preimage: Uint8Array;
  recoveryDelaySeconds: number;
}

const serialize = (p: CovenantContractParams): Record<string, string> => ({
  staticAddress: p.staticAddress,
  userPubkey: hex.encode(p.userPubkey),
  serverPubkey: hex.encode(p.serverPubkey),
  emulatorPubkey: hex.encode(p.emulatorPubkey),
  preimage: hex.encode(p.preimage),
  recoveryDelaySeconds: String(p.recoveryDelaySeconds),
});

const deserialize = (p: Record<string, string>): CovenantContractParams => ({
  staticAddress: p.staticAddress!,
  userPubkey: hex.decode(p.userPubkey!),
  serverPubkey: hex.decode(p.serverPubkey!),
  emulatorPubkey: hex.decode(p.emulatorPubkey!),
  preimage: hex.decode(p.preimage!),
  recoveryDelaySeconds: Number(p.recoveryDelaySeconds),
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

  /** A bare VtxoScript has no legacy `forfeit()`, so annotation cannot guess a leaf —
   *  the SDK's own escape hatch for program-compiled covenants like this one. Both
   *  point at the collaborative leaf: a forfeit and an intent proof are signed by the
   *  user and the operator together, which is the only leaf shaped that way. The sweep
   *  leaf needs a preimage and the emulator, and the recovery leaf is the user alone. */
  deriveTapscripts: (script) => ({
    forfeitTapLeafScript: script.leaves[COLLABORATIVE_LEAF]!,
    intentTapLeafScript: script.leaves[COLLABORATIVE_LEAF]!,
    tapTree: script.encode(),
  }),

  createScript: (params) => covenantVtxoScript(deserialize(params)).vtxo,
  serializeParams: serialize,
  deserializeParams: deserialize,

  getAllSpendingPaths: (script, contract) => pathsFor(script, contract),

  /** The recovery leaf is the user's alone and only after its CSV; the other two need
   *  a counterparty that is online now, which `collaborative` is exactly asking about. */
  getSpendablePaths(script, contract, context): PathSelection[] {
    const [sweep, collaborative, recovery] = pathsFor(script, contract);
    const fundedAt = context.vtxo?.status.block_time;
    const nowSeconds = Math.floor(context.chainTime ?? context.currentTime / 1000);
    const out: PathSelection[] = [];
    if (context.collaborative) out.push(sweep!, collaborative!);
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
