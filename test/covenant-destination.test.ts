import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { MultisigTapscript, VtxoScript } from "@arkade-os/sdk";
import { deriveCovenantDestination, createCovenantDestinationProvider, SWEEP_LEAF } from "../src/covenant-destination.js";
import { loadConfig } from "../src/config.js";

const xonly = (fill: number) => secp256k1.getPublicKey(new Uint8Array(32).fill(fill), true).subarray(1);
const serverPubkey = xonly(3);
const userPubkey = xonly(4);
const emulatorPubkey = secp256k1.getPublicKey(new Uint8Array(32).fill(5), true);
const staticAddress = new VtxoScript([
  MultisigTapscript.encode({ pubkeys: [xonly(9), serverPubkey] }).script,
]).address("tark", serverPubkey).encode();

const derive = (preimage: Uint8Array) =>
  deriveCovenantDestination({
    staticAddress,
    userPubkey,
    serverPubkey,
    emulatorPubkey,
    preimage,
    recoveryDelaySeconds: 4096,
  });

describe("deriveCovenantDestination", () => {
  // Every other case here picks 4096, which is a multiple of 512 by luck of the
  // draw. The shipped default was 86400, which is not, and BIP68 threw on it —
  // so the flag derived nothing and every payment fell back to the static
  // address. Derive at whatever config actually ships, not at a chosen value.
  it("derives at the shipped default recovery delay", () => {
    const { offlineReceive } = loadConfig({
      NODE_ENV: "test",
      DB_PATH: "unused-test.sqlite",
      ALLOW_INSECURE_TOKEN_STORAGE: "1",
      COVCLAIMD_URL: "https://cc.example",
      ARK_SERVER_URL: "https://ark.example",
      OFFLINE_COVENANT_DESTINATIONS: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
    });
    const d = deriveCovenantDestination({
      staticAddress,
      userPubkey,
      serverPubkey,
      emulatorPubkey,
      preimage: new Uint8Array(32).fill(7),
      recoveryDelaySeconds: offlineReceive.covenantRecoveryDelaySeconds,
    });
    expect(d.address.startsWith("tark1")).toBe(true);
  });

  // Golden values from the construction funded and swept on regtest, so a drift
  // here means the emulator would stop co-signing rather than a test going stale.
  it("reproduces the construction proven on-chain, byte for byte", () => {
    const d = derive(new Uint8Array(32).fill(7));

    expect(hex.encode(d.covenantScript)).toBe(
      "cd76d15188208ad35e9b86ff428ab4e125e27eb1bb05714dcb82a689ac1e40e736f4cfcdc12888cfcdc9a2",
    );
    expect(d.script).toBe("5120aaa385c70e9d339b3d1744ef2d409f9641a23c11370792b743ef2b485a71e1b1");
    expect(d.address).toBe(
      "tark1qpf3lesxsy69q0f8yvfnyf7gv7kglfkg83fhaxjyc0zmm0wtrl3n024rshrsa8fnnv73w38094qfl9jp5g7pzdc8j2m58metfpd8rcd37nqs45",
    );
  });

  it("gives every payment its own address while the covenant stays fixed", () => {
    const a = derive(new Uint8Array(32).fill(7));
    const b = derive(new Uint8Array(32).fill(8));

    expect(a.script).not.toBe(b.script);
    expect(hex.encode(a.covenantScript)).toBe(hex.encode(b.covenantScript));
  });

  it("pins the covenant to the user's static address, not the derived one", () => {
    const d = derive(new Uint8Array(32).fill(7));
    const staticKey = hex.encode(
      new VtxoScript([MultisigTapscript.encode({ pubkeys: [xonly(9), serverPubkey] }).script]).pkScript,
    ).slice(4);

    expect(hex.encode(d.covenantScript)).toContain(staticKey);
    expect(d.script).not.toBe(`5120${staticKey}`);
  });

  it("keeps the taptree decodable, since the sweep and covclaimd both need it", () => {
    const d = derive(new Uint8Array(32).fill(7));
    const decoded = VtxoScript.decode(d.tapTree);

    expect(decoded.scripts).toHaveLength(3);
    expect(hex.encode(decoded.pkScript)).toBe(d.script);
  });

  it("refuses a preimage that is not 32 bytes", () => {
    expect(() => derive(new Uint8Array(31).fill(7))).toThrow(/32 bytes/);
  });

  it("refuses a key that is neither 32 nor 33 bytes rather than truncating it", () => {
    expect(() =>
      deriveCovenantDestination({
        staticAddress,
        userPubkey: new Uint8Array(31).fill(4),
        serverPubkey,
        emulatorPubkey,
        preimage: new Uint8Array(32).fill(7),
        recoveryDelaySeconds: 4096,
      }),
    ).toThrow(/32- or 33-byte key/);
  });

  it("accepts a compressed user key and an x-only one as the same covenant", () => {
    const compressed = secp256k1.getPublicKey(new Uint8Array(32).fill(4), true);
    const withCompressed = deriveCovenantDestination({
      staticAddress,
      userPubkey: compressed,
      serverPubkey,
      emulatorPubkey,
      preimage: new Uint8Array(32).fill(7),
      recoveryDelaySeconds: 4096,
    });

    expect(withCompressed.script).toBe(derive(new Uint8Array(32).fill(7)).script);
  });
});

const kat = JSON.parse(readFileSync(new URL("./fixtures/covenant-entropy-kat.json", import.meta.url), "utf8")) as {
  covenant: { entries: { index: number; preimage: string; hash160: string }[] };
};

/** The HASH160 operand as the sweep leaf actually encodes it: `OP_HASH160
 *  <20 bytes> OP_EQUAL`. Read off the built script rather than recomputed, so a
 *  leaf that committed to something else could not agree with itself. */
function hash160InLeaf(leaf: Uint8Array): string {
  for (let i = 0; i + 22 <= leaf.length; i++) {
    if (leaf[i] === 0xa9 && leaf[i + 1] === 0x14 && leaf[i + 22] === 0x87) {
      return hex.encode(leaf.subarray(i + 2, i + 22));
    }
  }
  throw new Error("no HASH160 <20> EQUAL in the sweep leaf");
}

describe("the sweep leaf commits to the supplied preimage", () => {
  const { offlineReceive } = loadConfig({
    NODE_ENV: "test",
    DB_PATH: "unused-test.sqlite",
    ALLOW_INSECURE_TOKEN_STORAGE: "1",
    COVCLAIMD_URL: "https://cc.example",
    ARK_SERVER_URL: "https://ark.example",
    OFFLINE_COVENANT_DESTINATIONS: "true",
    OFFLINE_EMULATOR_URL: "https://emulator.example",
  });

  for (const entry of kat.covenant.entries) {
    it(`matches the fixture hash160 at index ${entry.index}`, () => {
      const d = deriveCovenantDestination({
        staticAddress,
        userPubkey,
        serverPubkey,
        emulatorPubkey,
        preimage: hex.decode(entry.preimage),
        recoveryDelaySeconds: offlineReceive.covenantRecoveryDelaySeconds,
      });
      expect(hash160InLeaf(VtxoScript.decode(d.tapTree).scripts[SWEEP_LEAF]!)).toBe(entry.hash160);
    });
  }

  it("moves the address when the preimage moves", () => {
    const at = (i: number) =>
      deriveCovenantDestination({
        staticAddress,
        userPubkey,
        serverPubkey,
        emulatorPubkey,
        preimage: hex.decode(kat.covenant.entries[i]!.preimage),
        recoveryDelaySeconds: offlineReceive.covenantRecoveryDelaySeconds,
      }).address;
    expect(at(0)).not.toBe(at(1));
  });
});

describe("createCovenantDestinationProvider", () => {
  const provider = (recoveryDelaySeconds: number) =>
    createCovenantDestinationProvider({
      arkServerUrl: "https://ark.example",
      covclaimdUrl: "https://cc.example",
      recoveryDelaySeconds,
    });

  it("refuses a delay BIP68 cannot encode instead of degrading per payment", () => {
    expect(() => provider(86_400)).toThrow(/positive multiple of 512/);
    expect(() => provider(3600)).toThrow(/positive multiple of 512/);
    expect(() => provider(0)).toThrow(/positive multiple of 512/);
    expect(() => provider(-512)).toThrow(/positive multiple of 512/);
    expect(() => provider(86_528)).not.toThrow();
  });

  it("accepts an emulator URL in place of covclaimd", () => {
    expect(() =>
      createCovenantDestinationProvider({
        arkServerUrl: "https://ark.example",
        emulatorUrl: "https://emulator.example",
        recoveryDelaySeconds: 86_528,
      }),
    ).not.toThrow();
    expect(() =>
      createCovenantDestinationProvider({
        arkServerUrl: "https://ark.example",
        recoveryDelaySeconds: 86_528,
      } as never),
    ).toThrow(/covclaimdUrl or emulatorUrl/);
  });
});

describe("deriving against a client-minted supply", () => {
  afterEach(() => vi.unstubAllGlobals());

  const EMULATOR = hex.encode(emulatorPubkey);
  const stubOperator = () =>
    vi.stubGlobal("fetch", async (url: string) =>
      new Response(
        JSON.stringify(
          String(url).includes("covclaimd-pubkey")
            ? { emulator_pub_key: EMULATOR }
            : { signerPubkey: hex.encode(serverPubkey) },
        ),
        { status: 200 },
      ));

  const build = (supply?: { allocate: (id: number) => { index: number; preimage: Uint8Array } | undefined }) =>
    createCovenantDestinationProvider({
      arkServerUrl: "https://ark.example",
      covclaimdUrl: "https://cc.example",
      recoveryDelaySeconds: 86_528,
      ...(supply ? { supply } : {}),
    });

  const identity = { arkadeAddress: staticAddress, claimPublicKey: hex.encode(userPubkey), addressId: 1 };

  it("reports the operator profile a supply is accepted against", async () => {
    stubOperator();
    await expect(build().profile()).resolves.toEqual({ emulatorPubkey: EMULATOR, recoveryDelaySeconds: 86_528 });
  });

  it("consumes supply in order and commits to exactly those preimages", async () => {
    stubOperator();
    const queue = kat.covenant.entries.map((e, index) => ({ index, preimage: hex.decode(e.preimage) }));
    const p = build({ allocate: () => queue.shift() });

    for (const entry of kat.covenant.entries) {
      const d = await p.derive(identity);
      expect(d.covenantIndex).toBe(kat.covenant.entries.indexOf(entry));
      const expected = deriveCovenantDestination({
        staticAddress, userPubkey, serverPubkey, emulatorPubkey,
        preimage: hex.decode(entry.preimage),
        recoveryDelaySeconds: 86_528,
      });
      expect(d.address).toBe(expected.address);
      expect(d.script).toBe(expected.script);
    }
  });

  it("falls back to a random preimage and reports no index when the supply is empty", async () => {
    stubOperator();
    const p = build({ allocate: () => undefined });
    const a = await p.derive(identity);
    const b = await p.derive(identity);

    expect(a.covenantIndex).toBeUndefined();
    expect(a.script).not.toBe(b.script);
  });

  it("does not touch the supply for an address it cannot name", async () => {
    stubOperator();
    const allocate = vi.fn();
    await build({ allocate }).derive({ arkadeAddress: staticAddress, claimPublicKey: hex.encode(userPubkey) });
    expect(allocate).not.toHaveBeenCalled();
  });
});
