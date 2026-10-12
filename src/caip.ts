import { isNetwork, type Network } from "@arkade-os/solver-discovery";

/** Mirrors intent-solver's `core/registryCard.ts`, which the registry validates. */
const NAMESPACE = { lightning: "bolt11", arkade: "arkade", onchain: "bitcoin" } as const;

export type RailType = keyof typeof NAMESPACE;

export function isRailType(value: string): value is RailType {
  return value in NAMESPACE;
}

// BTC-only rails, so the coin type is fixed by the network rather than open the
// way eip155's is: SLIP-44 reserves 1 for every testnet, 0 for mainnet.
export function caip19Id(type: RailType, network: Network): string {
  return `${NAMESPACE[type]}:${network}/slip44:${network === "bitcoin" ? 0 : 1}`;
}

const RAIL_BY_NAMESPACE = new Map<string, RailType>(
  (Object.keys(NAMESPACE) as RailType[]).map((type) => [NAMESPACE[type], type]),
);

export type Caip19Match =
  | { kind: "rail"; type: RailType }
  | { kind: "wrong-network"; got: string }
  | { kind: "unknown" };

/** A wrong network is reported separately because it is the one mistake a bare
 *  rail name cannot express — the whole reason for carrying the longer id. */
export function matchCaip19Id(id: string, network: Network): Caip19Match {
  const parts = id.split("/");
  const head = parts.length === 2 ? parts[0]!.split(":") : [];
  if (head.length !== 2) return { kind: "unknown" };
  const [namespace, chainRef] = head as [string, string];
  const assetRef = parts[1]!;
  const type = RAIL_BY_NAMESPACE.get(namespace);
  if (!type) return { kind: "unknown" };
  // A different recognised network is the one case worth naming; a bad coin type
  // on the right network is malformed, not a network mismatch.
  if (chainRef !== network) return isNetwork(chainRef) ? { kind: "wrong-network", got: chainRef } : { kind: "unknown" };
  return assetRef === `slip44:${network === "bitcoin" ? 0 : 1}` ? { kind: "rail", type } : { kind: "unknown" };
}
