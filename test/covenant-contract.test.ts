import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  MultisigTapscript,
  VtxoScript,
  type CreateContractParams,
  type IContractManager,
} from "@arkade-os/sdk";
import { covenantDestinationHandler as handler, COVENANT_CONTRACT_TYPE } from "../src/covenant-contract.js";
import { createCovenantDestinationProvider, covenantVtxoScript } from "../src/covenant-destination.js";

const xonly = (fill: number) => secp256k1.getPublicKey(new Uint8Array(32).fill(fill), true).subarray(1);
const serverPubkey = xonly(3);
const input = {
  staticAddress: new VtxoScript([MultisigTapscript.encode({ pubkeys: [xonly(9), serverPubkey] }).script])
    .address("tark", serverPubkey)
    .encode(),
  userPubkey: xonly(4),
  serverPubkey,
  emulatorPubkey: secp256k1.getPublicKey(new Uint8Array(32).fill(5), true),
  preimage: new Uint8Array(32).fill(7),
  recoveryDelaySeconds: 4096,
  refundLocktime: 1_800_000_000,
};

// Leaf selection, CSV timing and generic-spendability used to be tested here. They
// are the SDK's VHTLC handler's behaviour now, so asserting them would be testing
// the SDK. What stays is what this module still decides: the contract type, and
// that a stored contract rebuilds the address a payer was handed.
describe("covenantDestinationHandler", () => {
  it("carries this rail's own type, not the one swap lockups register under", () => {
    expect(handler.type).toBe(COVENANT_CONTRACT_TYPE);
    expect(handler.type).not.toBe("vhtlc-v2");
  });

  it("rebuilds the covenant proven on-chain, reached through the SDK handler", () => {
    const { vtxo } = covenantVtxoScript(input);
    const rebuilt = handler.createScript(handler.serializeParams(vtxo.options));

    expect(hex.encode(rebuilt.nonInteractiveClaim()[1])).toBe(
      "cd76d15188208ad35e9b86ff428ab4e125e27eb1bb05714dcb82a689ac1e40e736f4cfcdc12888cfcdc9a2",
    );
    expect(hex.encode(rebuilt.pkScript)).toBe(hex.encode(vtxo.pkScript));
  });
});

describe("createCovenantDestinationProvider registration", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/info") {
        res.end(JSON.stringify({ signerPubkey: hex.encode(secp256k1.getPublicKey(new Uint8Array(32).fill(3), true)) }));
        return;
      }
      res.end(JSON.stringify({ emulator_pub_key: hex.encode(input.emulatorPubkey) }));
    });
    await new Promise<void>((r) => {
      server.listen(0, "127.0.0.1", r);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // A payer handed an address nothing watches cannot be credited, so registration is
  // part of deriving rather than something the caller is trusted to do afterwards.
  it("registers each destination as an awaiting-funds contract before returning it", async () => {
    const created: CreateContractParams[] = [];
    const provider = createCovenantDestinationProvider({
      arkServerUrl: baseUrl,
      covclaimdUrl: baseUrl,
      recoveryDelaySeconds: 4096,
      contracts: { createContract: async (c: CreateContractParams) => created.push(c) } as unknown as IContractManager,
    });

    const derived = await provider.derive({
      arkadeAddress: input.staticAddress,
      claimPublicKey: hex.encode(input.userPubkey),
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: COVENANT_CONTRACT_TYPE,
      script: derived.script,
      address: derived.address,
      watch: "awaiting-funds",
    });
    // The stored params must rebuild the very script that was handed out, extra key
    // and all: the sweeper's preimage rides alongside the VHTLC's own parameters,
    // and `createScript` has to ignore it rather than choke on it.
    expect(hex.encode(handler.createScript(created[0]!.params).pkScript)).toBe(derived.script);
  });

  // The VHTLC parameters commit to the preimage HASH, so nothing else in the
  // contract would let the sweeper satisfy the hashlock.
  it("stores the preimage the sweep needs, which the VHTLC parameters do not carry", async () => {
    const created: CreateContractParams[] = [];
    const preimage = new Uint8Array(32).fill(0x3c);
    const provider = createCovenantDestinationProvider({
      arkServerUrl: baseUrl,
      covclaimdUrl: baseUrl,
      recoveryDelaySeconds: 4096,
      entropy: { preimage: () => preimage },
      contracts: { createContract: async (c: CreateContractParams) => created.push(c) } as unknown as IContractManager,
    });

    await provider.derive({ arkadeAddress: input.staticAddress, claimPublicKey: hex.encode(input.userPubkey) });

    expect(created[0]!.params.covenantPreimage).toBe(hex.encode(preimage));
    // Never under `preimage`: that key gates a different leaf in the SDK.
    expect(created[0]!.params.preimage).toBeUndefined();
  });

  it("refuses to hand out an address it could not register", async () => {
    const provider = createCovenantDestinationProvider({
      arkServerUrl: baseUrl,
      covclaimdUrl: baseUrl,
      recoveryDelaySeconds: 4096,
      contracts: {
        createContract: async () => {
          throw new Error("repository down");
        },
      } as unknown as IContractManager,
    });

    await expect(
      provider.derive({ arkadeAddress: input.staticAddress, claimPublicKey: hex.encode(input.userPubkey) }),
    ).rejects.toThrow(/repository down/);
  });
});
