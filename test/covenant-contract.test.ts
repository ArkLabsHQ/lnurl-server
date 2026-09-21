import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  ArkAddress,
  MultisigTapscript,
  VtxoScript,
  type Contract,
  type CreateContractParams,
  type IContractManager,
} from "@arkade-os/sdk";
import { covenantDestinationHandler as handler, COVENANT_CONTRACT_TYPE } from "../src/covenant-contract.js";
import {
  COVENANT_V1,
  COVENANT_V2,
  createCovenantDestinationProvider,
  enforcePayTo,
  enforcePayToWithAssets,
  deriveCovenantDestination,
  SWEEP_LEAF,
  RECOVERY_LEAF,
} from "../src/covenant-destination.js";

const xonly = (fill: number) => secp256k1.getPublicKey(new Uint8Array(32).fill(fill), true).subarray(1);
const serverPubkey = xonly(3);
const params = {
  staticAddress: new VtxoScript([MultisigTapscript.encode({ pubkeys: [xonly(9), serverPubkey] }).script])
    .address("tark", serverPubkey)
    .encode(),
  userPubkey: xonly(4),
  serverPubkey,
  emulatorPubkey: secp256k1.getPublicKey(new Uint8Array(32).fill(5), true),
  preimage: new Uint8Array(32).fill(7),
  recoveryDelaySeconds: 4096,
  version: COVENANT_V1,
};

const contract = (): Contract => ({
  type: COVENANT_CONTRACT_TYPE,
  params: handler.serializeParams(params),
  script: hex.encode(handler.createScript(handler.serializeParams(params)).pkScript),
  address: "tark1unused",
  state: "active",
  createdAt: Date.now(),
});

describe("covenantDestinationHandler", () => {
  // The whole point of routing through the SDK is that the bytes do not move: this is
  // the same value the golden test pins, reached through createScript instead.
  it("rebuilds the construction proven on-chain, byte for byte", () => {
    const script = handler.createScript(handler.serializeParams(params));

    expect(hex.encode(script.pkScript)).toBe("5120aaa385c70e9d339b3d1744ef2d409f9641a23c11370792b743ef2b485a71e1b1");
    expect(hex.encode(script.pkScript)).toBe(deriveCovenantDestination(params).script);
  });

  /**
   * A COMPATIBILITY FIXTURE, not a golden value: a literal `ark_contracts` row,
   * carrying no version key because v1 rows have none. Re-pinning it says every
   * destination already handed to a payer is orphaned — their sweep would address
   * a taptree nobody funded, which arkd refuses in silence. Version and branch.
   */
  it("still rebuilds a stored v1 row that predates any version key", () => {
    const v1Row: Record<string, string> = {
      staticAddress: "tark1qpf3lesxsy69q0f8yvfnyf7gv7kglfkg83fhaxjyc0zmm0wtrl3n0zknt6dcdl6z326wzf0z06cmkpt3fh9c9f5f4s0ypeek7n8umsfgt0g0l3",
      userPubkey: "462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0b",
      serverPubkey: "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
      emulatorPubkey: "0362c0a046dacce86ddd0343c6d3c7c79c2208ba0d9c9cf24a6d046d21d21f90f7",
      preimage: "07".repeat(32),
      recoveryDelaySeconds: "4096",
    };

    expect(hex.encode(handler.createScript(v1Row).pkScript))
      .toBe("5120aaa385c70e9d339b3d1744ef2d409f9641a23c11370792b743ef2b485a71e1b1");
  });

  // v2 must actually differ, or the version enforces nothing.
  it("derives a different address for v2, carrying the asset tunnel", () => {
    const v1 = handler.createScript(handler.serializeParams(params));
    const v2 = handler.createScript(handler.serializeParams({ ...params, version: COVENANT_V2 }));

    expect(hex.encode(v2.pkScript)).not.toBe(hex.encode(v1.pkScript));
    // tunnel prefix, then the v1 bytes unchanged beneath it.
    const covenantV1 = enforcePayTo(ArkAddress.decode(params.staticAddress).pkScript);
    const covenantV2 = enforcePayToWithAssets(ArkAddress.decode(params.staticAddress).pkScript);
    expect(hex.encode(covenantV2)).toBe("cd5400f769" + hex.encode(covenantV1));
  });

  it("round-trips its parameters through storage", () => {
    expect(handler.deserializeParams(handler.serializeParams(params))).toEqual(params);
  });

  it("offers the three leaves, with the preimage on the sweep and a sequence on recovery", () => {
    const script = handler.createScript(handler.serializeParams(params));
    const paths = handler.getAllSpendingPaths(script, contract(), { collaborative: true, currentTime: Date.now() });

    expect(paths).toHaveLength(3);
    expect(paths[SWEEP_LEAF]!.extraWitness).toEqual([params.preimage]);
    expect(paths[RECOVERY_LEAF]!.sequence).toBeTypeOf("number");
    expect(paths[1]!.extraWitness).toBeUndefined();
  });

  it("picks the sweep leaf, the only path this service can complete", () => {
    const script = handler.createScript(handler.serializeParams(params));
    const chosen = handler.selectPath(script, contract(), { collaborative: true, currentTime: Date.now() });

    expect(chosen?.leaf).toEqual(script.leaves[SWEEP_LEAF]);
    expect(handler.selectPath(script, contract(), { collaborative: false, currentTime: Date.now() })).toBeNull();
  });

  it("measures CSV from the VTXO confirmation using seconds-typed chain time", () => {
    const script = handler.createScript(handler.serializeParams(params));
    const fresh = contract();
    const fundedAt = 1_700_000_000;
    const vtxo = { status: { block_time: fundedAt } } as never;

    expect(handler.getSpendablePaths(script, fresh, {
      collaborative: true, currentTime: (fundedAt + 10_000) * 1000, chainTime: fundedAt + 4095, vtxo,
    })).toHaveLength(2);
    expect(
      handler.getSpendablePaths(script, fresh, {
        collaborative: true, currentTime: fundedAt * 1000, chainTime: fundedAt + 4096, vtxo,
      }),
    ).toHaveLength(3);
  });

  it("withholds CSV recovery until funding time is known", () => {
    const script = handler.createScript(handler.serializeParams(params));
    const oldContract = { ...contract(), createdAt: 1 };

    expect(handler.getSpendablePaths(script, oldContract, {
      collaborative: true, currentTime: Date.now(),
    })).toHaveLength(2);
  });

  it("keeps these outputs out of generic wallet spending", () => {
    expect(handler.isGenericallySpendable?.(contract())).toBe(false);
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
      res.end(JSON.stringify({ emulator_pub_key: hex.encode(params.emulatorPubkey) }));
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
      arkadeAddress: params.staticAddress,
      claimPublicKey: hex.encode(params.userPubkey),
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: COVENANT_CONTRACT_TYPE,
      script: derived.script,
      address: derived.address,
      watch: "awaiting-funds",
    });
    // The stored params must rebuild the very script that was handed out.
    expect(hex.encode(handler.createScript(created[0]!.params).pkScript)).toBe(derived.script);
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
      provider.derive({ arkadeAddress: params.staticAddress, claimPublicKey: hex.encode(params.userPubkey) }),
    ).rejects.toThrow(/repository down/);
  });
});
