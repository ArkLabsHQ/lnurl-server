import { describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import {
  DefaultContractHandler, DefaultVtxo, SeedIdentity, Transaction, deriveDescriptorLeafCompressedPubKey,
  resolveDescriptorSigner, type Contract, type CreateContractParams,
} from "@arkade-os/sdk";
import { createHdReceiveBranch, restoreHdReceiveAllocation, type HdReceiveAllocation } from "../src/hd.js";
import { createLnurlClient } from "../src/index.js";
import { arkadeLnurl } from "../src/wallet.js";

const seed = new Uint8Array(64).fill(7);
const identity = () => SeedIdentity.fromSeed(seed, { isMainnet: false });
const settings = {
  serverPubKey: hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(2))),
  hrp: "tark" as const, exitDelay: { type: "seconds" as const, value: 1024 },
};
const branchOf = (branchPath = "2/7") => createHdReceiveBranch({ accountDescriptor: identity().descriptor, branchPath, ...settings });
function allocationOf(index = 41): HdReceiveAllocation {
  const { hd } = branchOf();
  const descriptor = hd.descriptor.replace("*", String(index));
  const publicKey = deriveDescriptorLeafCompressedPubKey(descriptor);
  const script = new DefaultVtxo.Script({
    pubKey: publicKey.slice(1), serverPubKey: hex.decode(hd.serverPubKey),
    csvTimelock: { type: hd.exitDelay.type, value: BigInt(hd.exitDelay.value) },
  });
  return {
    id: 50, index, descriptor, hd, claimPublicKey: hex.encode(publicKey), createdAt: 1,
    arkadeAddress: script.address(hd.hrp, hex.decode(hd.serverPubKey)).encode(),
  };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

describe("HD receiving", () => {
  it("exports only the dedicated public branch and derives the same leaf under the original account", () => {
    const branch = branchOf();
    expect(branch.hd.descriptor).toMatch(/^tr\(\[[0-9a-f]{8}\/86'\/1'\/0'\/2\/7\]tpub[^/]+\/\*\)$/);
    expect(branch.hd.descriptor).not.toContain(identity().descriptor.split("]")[1]!.split("/")[0]);
    expect(deriveDescriptorLeafCompressedPubKey(branch.signingDescriptor(41)))
      .toEqual(deriveDescriptorLeafCompressedPubKey(allocationOf().descriptor));
    expect(allocationOf(42).arkadeAddress).not.toBe(allocationOf(41).arkadeAddress);
  });

  it.each(["0", "0/7", "1/7", "2/1'", "2/-1", "2/2147483648", "2/01", ""])("rejects an unsafe branch %s", (branchPath) => {
    expect(() => branchOf(branchPath)).toThrow();
  });

  it("restores after seed recreation beyond unpaid gaps and signs with the restored child", async () => {
    const allocation = allocationOf();
    const createContract = vi.fn(async (params: CreateContractParams): Promise<Contract> => ({ ...params, createdAt: 1, state: "active" }));
    const restored = await restoreHdReceiveAllocation({ createContract }, allocation, branchOf());
    const script = DefaultContractHandler.createScript(restored.params);
    expect(hex.encode(script.pkScript)).toBe(restored.script);
    expect(restored.watch).toBe("awaiting-funds");
    const descriptor = restored.metadata!.signingDescriptor as string;
    const recreated = identity();
    await expect(resolveDescriptorSigner(allocation.descriptor, recreated)).rejects.toThrow();
    const signer = await resolveDescriptorSigner(descriptor, recreated);
    const message = new Uint8Array(32).fill(3);
    const signature = await signer.signMessage(message, "schnorr");
    expect(schnorr.verify(signature, message, hex.decode(allocation.claimPublicKey).slice(1))).toBe(true);
    expect(await signer.compressedPublicKey()).toEqual(hex.decode(allocation.claimPublicKey));
    const tx = new Transaction({ allowUnknownOutputs: true });
    tx.addInput({ txid: "11".repeat(32), index: 0, witnessUtxo: { script: script.pkScript, amount: 1000n }, tapLeafScript: [script.forfeit()] });
    tx.addOutput({ script: script.pkScript, amount: 900n });
    const signed = await signer.sign(tx, [0]);
    expect(signed.getInput(0).tapScriptSig).toHaveLength(1);
    expect(signed.getInput(0).tapScriptSig![0]![0].pubKey).toEqual(hex.decode(allocation.claimPublicKey).slice(1));
  });

  it("rejects tampered allocations before registering a watch", async () => {
    const createContract = vi.fn();
    for (const allocation of [
      { ...allocationOf(), arkadeAddress: allocationOf(42).arkadeAddress },
      { ...allocationOf(), claimPublicKey: allocationOf(42).claimPublicKey },
      { ...allocationOf(), index: 42 },
      { ...allocationOf(), hd: { ...branchOf().hd, serverPubKey: "ff".repeat(32) } },
    ]) await expect(restoreHdReceiveAllocation({ createContract }, allocation, branchOf())).rejects.toThrow();
    expect(createContract).not.toHaveBeenCalled();
  });

  it("normalizes accepted configuration before restoring the server's canonical allocation", async () => {
    const branch = createHdReceiveBranch({ accountDescriptor: identity().descriptor.replaceAll("'", "h"), branchPath: "2/7", ...settings, serverPubKey: settings.serverPubKey.toUpperCase() });
    const createContract = vi.fn(async (params: CreateContractParams): Promise<Contract> => ({ ...params, createdAt: 1, state: "active" }));
    await expect(restoreHdReceiveAllocation({ createContract }, allocationOf(), branch)).resolves.toBeDefined();
  });

  it("sends only HD configuration, requires server acknowledgement, and authenticates allocation pages", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => json(init?.method === "POST" ? { receiveMode: "hd" } : { allocations: [allocationOf()], nextAfter: 50 }));
    const client = createLnurlClient({ baseUrl: "https://receiver.example", fetchImpl });
    await client.registerArkadeIdentity({ token: "secret", handle: "alice", domain: "example", hd: branchOf().hd });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({ domain: "example", hd: branchOf().hd });
    expect(fetchImpl.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect((await client.listHdAllocations("secret", "alice", { domain: "example", after: 30, limit: 10 })).nextAfter).toBe(50);
    expect(fetchImpl.mock.calls[1]![0]).toBe("https://receiver.example/lnurl/address/alice/arkade/allocations?domain=example&after=30&limit=10");
    const old = createLnurlClient({ baseUrl: "https://old.example", fetchImpl: async () => json({ ok: true }) });
    await expect(old.registerArkadeIdentity({ token: "secret", handle: "alice", hd: branchOf().hd })).rejects.toThrow("did not confirm HD");
  });

  it("keeps authentication separate and never reads ordinary wallet addresses in HD mode", async () => {
    const wallet = { identity: identity(), getAddress: vi.fn(), getBoardingAddress: vi.fn() };
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST" && !(_url.endsWith("/arkade"))) {
        return json({ handle: "alice", lightningAddress: "alice@example.com" });
      }
      return json(init?.method === "POST" ? { receiveMode: "hd" } : { allocations: [], nextAfter: 0 });
    });
    const lnurl = arkadeLnurl({ wallet, hd: branchOf().hd, baseUrl: "https://receiver.example", client: createLnurlClient({ baseUrl: "https://receiver.example", fetchImpl }) });
    const receiver = await lnurl.claim({ username: "alice" });
    await receiver.allocations();
    expect(wallet.getAddress).not.toHaveBeenCalled();
    expect(wallet.getBoardingAddress).not.toHaveBeenCalled();
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string)).toEqual({ domain: "receiver.example", hd: branchOf().hd });
  });

  it("rejects allocation pages that can rewind or skip the recovery cursor", async () => {
    for (const page of [
      { allocations: [allocationOf()], nextAfter: 49 },
      { allocations: [allocationOf(), allocationOf()], nextAfter: 50 },
      { allocations: [], nextAfter: 0 },
      { allocations: [{ ...allocationOf(), index: -1 }], nextAfter: 50 },
    ]) {
      const client = createLnurlClient({ baseUrl: "https://receiver.example", fetchImpl: async () => json(page) });
      await expect(client.listHdAllocations("secret", "alice", { after: 30 })).rejects.toThrow("Invalid HD allocation");
    }
  });
});
