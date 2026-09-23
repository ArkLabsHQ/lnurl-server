import { describe, it, expect } from "vitest";
import { SingleKey, ArkAddress } from "@arkade-os/sdk";
import * as client from "../packages/client/src/setup.js";
import * as server from "../src/enclave/owner-setup.js";

const DESTINATION = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), "tark").encode();
const PARAMS = {
  deployment: "lnurl-test", tenant: "wallet.example", network: "regtest", domain: "wallet.example", username: "alice",
  arkadeDestination: DESTINATION, claimPublicKey: "02" + "ab".repeat(32), rails: ["arkade", "offline-swap"] as const,
};

/** One key of each parity: the owner key travels x-only, so an odd one is where a slip would show. */
async function keysOfBothParities(): Promise<SingleKey[]> {
  const found = new Map<number, SingleKey>();
  for (let i = 1; found.size < 2; i++) {
    const key = SingleKey.fromHex(i.toString(16).padStart(2, "0").repeat(32));
    found.set((await key.compressedPublicKey())[0]!, key);
  }
  return [...found.values()];
}

describe("the client's owner setups against the server's", () => {
  it("signs a setup an independent verifier accepts", async () => {
    for (const key of await keysOfBothParities()) {
      const setup = await client.buildOwnerSetup(key, PARAMS);
      const { payload, signature } = await client.signOwnerSetup(key, setup);
      const decoded = server.decodeOwnerSetup(payload);
      expect(decoded).toEqual(setup);
      expect(server.verifyOwnerSetup(decoded, signature, (await key.compressedPublicKey()).slice(1))).toBe(true);
    }
  });

  it("encodes byte for byte as the server does, for every shape a chain takes", async () => {
    const [ownerKey, nextKey] = await keysOfBothParities();
    const first = await client.buildOwnerSetup(ownerKey!, PARAMS);
    const second = client.nextOwnerSetup(first, { boardingAddress: "tb1qowner", rails: ["onchain", "arkade"] });
    const rotated = (await client.rotateOwnerSetup(ownerKey!, nextKey!, second)).setup;
    const revoked = client.nextOwnerSetup(rotated, { intent: "revoke" });
    for (const setup of [first, second, rotated, revoked]) {
      expect(client.encodeOwnerSetup(setup)).toEqual(server.encodeOwnerSetup(setup));
      expect(client.ownerSetupDigest(setup)).toEqual(server.ownerSetupDigest(setup));
      expect(client.decodeOwnerSetup(server.encodeOwnerSetup(setup))).toEqual(setup);
    }
  });

  it("refuses what the server refuses", () => {
    const base = { ...PARAMS, intent: "set" as const, ownerPublicKey: "ab".repeat(32), revision: 1 };
    const bad = [
      { ...base, username: "Alice" },
      { ...base, claimPublicKey: "02" + "00".repeat(31) + "05" },
      { ...base, rails: ["arkade", "arkade"] as const },
      { ...base, boardingAddress: "" },
      { ...base, revision: 2 },
      { ...base, previousHash: "00".repeat(32) },
    ];
    for (const setup of bad) {
      expect(() => server.encodeOwnerSetup(setup as server.OwnerSetup)).toThrow();
      expect(() => client.encodeOwnerSetup(setup as client.OwnerSetup)).toThrow();
    }
  });
});
