import { describe, expect, it } from "vitest";
import type { SolverCandidate } from "../src/services/solver-discovery.js";
import { rankReceiveSolvers } from "../src/services/solver-routing.js";
import { legacyBtcSolverCard, solverCard } from "./fixtures/solver-cards.js";

const network = "mutinynet";
const candidate = (name: Parameters<typeof solverCard>[0], fee: number, legacy = false): SolverCandidate => {
  const card = legacy ? legacyBtcSolverCard(name, fee) : solverCard(name, fee, network);
  const source = `local:${name}`;
  return {
    name, discoveryPubkey: card.discovery_pubkey!, relays: card.transports!.nostr!.relays,
    source, sourceType: "local",
    market: { ...card.markets[0]!, solver: name, discovery_pubkey: card.discovery_pubkey!, source, sourceType: "local" },
  };
};

describe("receive solver ordering", () => {
  const cheap = candidate("cheap", 10);
  const backup = candidate("backup", 200, true);
  const registry = candidate("registry", 100);
  const discovered = [backup, registry, cheap];

  it("keeps discovery order by default and applies the manual order by eligible public key", async () => {
    await expect(rankReceiveSolvers(discovered, network, { mode: "manual" }, 10_000, "from")).resolves.toEqual(discovered);
    await expect(rankReceiveSolvers(discovered, network, {
      mode: "manual", priority: [cheap.discoveryPubkey], preferFirst: "aa".repeat(32),
    }, 10_000, "from")).resolves.toEqual([cheap, backup, registry]);
  });

  it("uses completed counts with manual tie order and an eligible preferred solver first", async () => {
    const usage = new Map([[cheap.discoveryPubkey, 12], [registry.discoveryPubkey, 3], [backup.discoveryPubkey, 3]]);
    await expect(rankReceiveSolvers(discovered, network, {
      mode: "usage", priority: [registry.discoveryPubkey],
    }, 10_000, "from", usage)).resolves.toEqual([cheap, registry, backup]);
    await expect(rankReceiveSolvers(discovered, network, {
      mode: "usage", preferFirst: backup.discoveryPubkey,
    }, 10_000, "from", usage)).resolves.toEqual([backup, cheap, registry]);
  });

  it.each(["from", "to"] as const)("ranks fee estimates for amount side %s", async (side) => {
    await expect(rankReceiveSolvers(discovered, network, { mode: "cost" }, 10_000, side))
      .resolves.toEqual([cheap, registry, backup]);
  });
});
