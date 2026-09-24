import { describe, it, expect } from "vitest";
import http from "node:http";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { MultisigTapscript, VtxoScript } from "@arkade-os/sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { deriveCovenantDestination, createCovenantDestinationProvider, SWEEP_LEAF } from "../src/covenant/destination.js";
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

describe("createCovenantDestinationProvider", () => {
  const provider = (recoveryDelaySeconds: number) =>
    createCovenantDestinationProvider({
      arkServerUrl: "https://ark.example",
      covclaimdUrl: "https://cc.example",
      recoveryDelaySeconds,
    });

  // The seam is only worth having if the bytes reach the script. Read off the
  // decoded sweep leaf rather than recomputed, so derivation and construction
  // cannot drift apart while both look right.
  it("commits the sweep leaf to whatever the entropy provider returned", async () => {
    const preimage = new Uint8Array(32).fill(0x2b);
    const stub = async (url: string | URL): Promise<Response> => {
      const body = String(url).includes("covclaimd-pubkey")
        ? { emulator_pub_key: hex.encode(emulatorPubkey) }
        : { signerPubkey: hex.encode(secp256k1.getPublicKey(new Uint8Array(32).fill(3), true)) };
      return { ok: true, json: async () => body } as Response;
    };
    const original = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      const derived = await createCovenantDestinationProvider({
        arkServerUrl: "https://ark.example",
        covclaimdUrl: "https://cc.example",
        recoveryDelaySeconds: 86_528,
        entropy: { preimage: () => preimage },
      }).derive({ arkadeAddress: staticAddress, claimPublicKey: hex.encode(secp256k1.getPublicKey(new Uint8Array(32).fill(4), true)) });

      const expected = hex.encode(ripemd160(sha256(preimage)));
      const leaf = VtxoScript.decode(deriveCovenantDestination({
        staticAddress,
        userPubkey,
        serverPubkey,
        emulatorPubkey,
        preimage,
        recoveryDelaySeconds: 86_528,
      }).tapTree).scripts[SWEEP_LEAF]!;
      let found = "";
      for (let i = 0; i + 22 <= leaf.length; i++) {
        if (leaf[i] === 0xa9 && leaf[i + 1] === 0x14 && leaf[i + 22] === 0x87) found = hex.encode(leaf.subarray(i + 2, i + 22));
      }
      expect(found).toBe(expected);
      expect(derived.address).toMatch(/^tark1/);
    } finally {
      globalThis.fetch = original;
    }
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

describe("covenant destination key fetches", () => {
  const listen = (handler: http.RequestListener) =>
    new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const s = http.createServer(handler);
      s.listen(0, "127.0.0.1", () =>
        resolve({
          url: `http://127.0.0.1:${(s.address() as { port: number }).port}`,
          close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }),
        }),
      );
    });

  const address = { arkadeAddress: staticAddress, claimPublicKey: hex.encode(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true)) };

  it("fetches the operator and emulator keys once for concurrent derivations", async () => {
    let infoHits = 0;
    const ark = await listen((_req, res) => {
      infoHits++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ signerPubkey: hex.encode(serverPubkey) }));
    });
    const emulator = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ signerPubkey: hex.encode(emulatorPubkey) }));
    });
    try {
      const provider = createCovenantDestinationProvider({
        arkServerUrl: ark.url, emulatorUrl: emulator.url, recoveryDelaySeconds: 4096,
      });
      await Promise.all(Array.from({ length: 10 }, () => provider.derive(address)));
      // The cache stored a resolved value, so ten callers raced ten fetch pairs.
      expect(infoHits).toBe(1);
    } finally {
      await ark.close();
      await emulator.close();
    }
  });

  it("gives up on a hung endpoint instead of holding the caller forever", async () => {
    const hung = await listen(() => { /* accepts, never answers */ });
    try {
      const provider = createCovenantDestinationProvider({
        arkServerUrl: hung.url, emulatorUrl: hung.url, recoveryDelaySeconds: 4096, requestTimeoutMs: 80,
      });
      await expect(provider.derive(address)).rejects.toThrow();
    } finally {
      await hung.close();
    }
  });
});
