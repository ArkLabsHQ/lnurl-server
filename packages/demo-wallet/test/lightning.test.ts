import { describe, expect, it } from "vitest";
import type { SwapClient } from "@arkade-os/swap";
import { buildInvoice } from "../../../test/helpers/bolt11.js";
import { createLightningRail, rfqTransportFor } from "../src/lightning.js";

describe("rfqTransportFor", () => {
  const rendezvous = { solverPubkey: "33".repeat(32), relays: [], card: {} } as never;

  it("trusts the configured HTTP solver on regtest only", async () => {
    const regtest = rfqTransportFor("regtest", "http://solver.test");
    expect((await regtest!(rendezvous)).attestedResponder).toBe("33".repeat(32));
    for (const network of ["mutinynet", "signet", "bitcoin"]) {
      expect(rfqTransportFor(network, "http://solver.test")).toBeUndefined();
    }
    expect(rfqTransportFor("regtest", undefined)).toBeUndefined();
  });
});

describe("createLightningRail", () => {
  it("loads markets first and drops only an amount the invoice already states", async () => {
    const invoice = buildInvoice("ab".repeat(32), { amountHrp: "20u" });
    const calls: unknown[] = [];
    const client = {
      markets: async () => { calls.push("markets"); return []; },
      resolve: async (input: unknown) => { calls.push(input); return { eligible: 1 }; },
    } as unknown as SwapClient;
    const rail = createLightningRail(client);

    expect(await rail.available!({ raw: invoice, amount: 2000 }, {} as never)).toBe(true);
    expect(await rail.available!({ raw: invoice, amount: 1999 }, {} as never)).toBe(true);
    expect(calls).toEqual(["markets", { to: invoice }, "markets", { to: invoice, amount: 1999n, amountOn: "take" }]);
  });
});
