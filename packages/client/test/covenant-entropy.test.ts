import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hex } from "@scure/base";
import { MnemonicIdentity, SingleKey } from "@arkade-os/sdk";
import {
  COVENANT_SUPPLY_SCHEME,
  derivePreimage,
  mintCovenantSupply,
  preimageHash160,
  supplySalt,
  type SupplyLeg,
} from "../src/covenant-entropy.js";

interface Entry { index: number; salt: string; preimage: string; hash160: string }
interface Leg { scheme: string; domainTag: string; domainSalt: string; entries: Entry[] }
interface Kat {
  mnemonic: string;
  domain: string;
  domainNormalised: string;
  identityXOnly: string;
  covenant: Leg;
  swap: Leg;
}

const kat = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../test/fixtures/covenant-entropy-kat.json", import.meta.url)), "utf8"),
) as Kat;

const identity = MnemonicIdentity.fromMnemonic(kat.mnemonic, { isMainnet: false });

describe("covenant supply known-answer vectors", () => {
  it("derives the identity the fixture was built from", async () => {
    expect(hex.encode(await identity.xOnlyPublicKey())).toBe(kat.identityXOnly);
  });

  for (const leg of ["covenant", "swap"] as SupplyLeg[]) {
    describe(leg, () => {
      const vectors = kat[leg];

      it("reproduces every salt, preimage and hash160", async () => {
        expect(vectors.scheme).toBe(COVENANT_SUPPLY_SCHEME);
        for (const entry of vectors.entries) {
          expect(hex.encode(supplySalt(leg, kat.domain, entry.index))).toBe(entry.salt);
          const preimage = await derivePreimage(identity, leg, kat.domain, entry.index);
          expect(hex.encode(preimage)).toBe(entry.preimage);
          expect(hex.encode(preimageHash160(preimage))).toBe(entry.hash160);
        }
      });

      it("normalises the domain the way the session token does", () => {
        expect(hex.encode(supplySalt(leg, kat.domain, 0))).toBe(
          hex.encode(supplySalt(leg, kat.domainNormalised, 0)),
        );
      });
    });
  }

  // A KAT alone passes even if a field never reaches the salt message, so move
  // exactly one input at a time and require the preimage to move with it.
  describe("one-axis sensitivity", () => {
    const base = { leg: "covenant" as SupplyLeg, domain: kat.domainNormalised, index: 0 };
    const p = (o: Partial<typeof base> & { identity?: typeof identity }) =>
      derivePreimage(o.identity ?? identity, o.leg ?? base.leg, o.domain ?? base.domain, o.index ?? base.index);

    it("changes with the domain alone", async () => {
      expect(hex.encode(await p({ domain: "other.example" }))).not.toBe(kat.covenant.entries[0]!.preimage);
    });

    it("changes with the index alone", async () => {
      expect(hex.encode(await p({ index: 1 }))).not.toBe(kat.covenant.entries[0]!.preimage);
    });

    it("changes with the mnemonic alone", async () => {
      const other = MnemonicIdentity.fromMnemonic(
        "legal winner thank year wave sausage worth useful legal winner thank yellow",
        { isMainnet: false },
      );
      expect(hex.encode(await p({ identity: other }))).not.toBe(kat.covenant.entries[0]!.preimage);
    });

    it("changes with the leg alone, so the two rails never share a secret", async () => {
      expect(hex.encode(await p({ leg: "swap" }))).toBe(kat.swap.entries[0]!.preimage);
      expect(kat.swap.entries[0]!.preimage).not.toBe(kat.covenant.entries[0]!.preimage);
    });
  });

  it("derives identically across independently constructed identities", async () => {
    const a = MnemonicIdentity.fromMnemonic(kat.mnemonic, { isMainnet: false });
    const b = MnemonicIdentity.fromMnemonic(kat.mnemonic, { isMainnet: false });
    expect(hex.encode(await derivePreimage(a, "covenant", kat.domain, 7))).toBe(
      hex.encode(await derivePreimage(b, "covenant", kat.domain, 7)),
    );
  });
});

describe("mintCovenantSupply", () => {
  const key = SingleKey.fromPrivateKey(new Uint8Array(32).fill(11));

  it("mints a contiguous batch from startIndex", async () => {
    const supply = await mintCovenantSupply(key, { domain: "example.com", startIndex: 5, count: 3 });
    expect(supply).toMatchObject({ scheme: COVENANT_SUPPLY_SCHEME, startIndex: 5 });
    expect(supply.preimages).toHaveLength(3);
    for (const [offset, value] of supply.preimages.entries()) {
      expect(value).toBe(hex.encode(await derivePreimage(key, "covenant", "example.com", 5 + offset)));
    }
  });

  it("defaults to the covenant leg and takes the swap leg only when asked", async () => {
    const covenant = await mintCovenantSupply(key, { domain: "example.com", startIndex: 0, count: 1 });
    const swap = await mintCovenantSupply(key, { leg: "swap", domain: "example.com", startIndex: 0, count: 1 });
    expect(covenant.preimages[0]).not.toBe(swap.preimages[0]);
  });

  it("rejects a count outside the server's cap", async () => {
    await expect(mintCovenantSupply(key, { domain: "example.com", startIndex: 0, count: 0 })).rejects.toThrow(/count must be/);
    await expect(mintCovenantSupply(key, { domain: "example.com", startIndex: 0, count: 257 })).rejects.toThrow(/count must be/);
  });

  it("rejects a non-u32 index", async () => {
    await expect(mintCovenantSupply(key, { domain: "example.com", startIndex: -1, count: 1 })).rejects.toThrow(/u32/);
  });
});
