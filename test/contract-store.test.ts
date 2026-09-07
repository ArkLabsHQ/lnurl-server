import { describe, it, expect } from "vitest";
import { openDb } from "../src/db/connection.js";
import { sqliteContractStores } from "../src/contract-store.js";

const contract = (script: string) => ({
  type: "lnurl-covenant-destination",
  params: { preimage: "07".repeat(32), payoutScript: `5120${"aa".repeat(32)}` },
  script,
  address: "tark1probe",
  state: "active" as const,
  watch: "awaiting-funds" as const,
  createdAt: Date.now(),
});

describe("contract stores", () => {
  it("round-trips a custom contract type through our own sqlite handle", async () => {
    const { contractRepository } = await sqliteContractStores(openDb(":memory:"));
    await contractRepository.saveContract(contract(`5120${"bb".repeat(32)}`));

    const [saved] = await contractRepository.getContracts({ type: "lnurl-covenant-destination" });
    expect(saved).toMatchObject({ type: "lnurl-covenant-destination", watch: "awaiting-funds", state: "active" });
    expect(saved!.params.preimage).toBe("07".repeat(32));
  });

  // The SDK owns these tables, so a missing one means its schema moved under us
  // rather than a migration of ours being wrong. Init is lazy — constructing the
  // repository touches nothing, so a caller that only ever constructs sees no table.
  it("creates its own tables on first use, not at construction", async () => {
    const db = openDb(":memory:");
    const tables = () =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);

    const { contractRepository } = await sqliteContractStores(db);
    expect(tables()).not.toContain("ark_contracts");

    await contractRepository.getContracts();
    expect(tables()).toContain("ark_contracts");
  });

});
