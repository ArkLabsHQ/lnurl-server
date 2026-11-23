import { rankSolverMarkets, solverId } from "@arkade-os/solver-discovery";
import type { OfflineSolverRoutingConfig } from "../config.js";
import type { SolverCandidate } from "./solver-discovery.js";

export async function rankReceiveSolvers(
  candidates: readonly SolverCandidate[],
  network: string,
  policy: OfflineSolverRoutingConfig,
  amountSat: number,
  amountSide: "from" | "to",
  usage?: ReadonlyMap<string, number>,
): Promise<SolverCandidate[]> {
  const markets = candidates.map((candidate) => ({
    candidate,
    card: candidate.market,
    give: "quote" as const,
    key: candidate.discoveryPubkey.toLowerCase(),
    id: solverId(candidate.market, network),
  }));
  const ranked = await rankSolverMarkets(markets, {
    network,
    preferences: {
      mode: policy.mode,
      priority: policy.priority?.flatMap((key) => markets.filter((market) => market.key === key).map((market) => market.id)),
      preferFirst: markets.find(({ key }) => key === policy.preferFirst)?.id,
      ...(usage ? { usage: Object.fromEntries(markets.map(({ id, key }) => [id, usage.get(key) ?? 0])) } : {}),
    },
    amount: { on: amountSide === "from" ? "give" : "take", value: BigInt(amountSat) },
    // The receive corridor is BTC on both legs. Cost ordering only needs its advertised fees.
    fetchImpl: async () => { throw new Error("Lightning receive cost uses same-asset prices"); },
  });
  return ranked.map(({ candidate }) => candidate);
}
