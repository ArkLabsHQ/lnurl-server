import { describe, expect, it } from "vitest";
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ArkAddress, DefaultVtxo, deriveDescriptorLeafCompressedPubKey } from "@arkade-os/sdk";
import { deriveHdReceive, hdReceiveSourceId, validateHdReceive } from "../src/hd-receive.js";

const codec = createBase58check(sha256);
const payload = Buffer.alloc(78, 1);
payload.writeUInt32BE(0x043587cf, 0);
payload[4] = 4;
payload.set(secp256k1.getPublicKey(new Uint8Array(32).fill(1)), 45);
const xpub = codec.encode(payload);
const config = {
  version: 1, descriptor: `tr([12345678/86'/1'/0'/0]${xpub}/*)`,
  serverPubKey: Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(2))).subarray(1).toString("hex"),
  hrp: "tark", exitDelay: { type: "seconds", value: 512 },
};

describe("HD receive derivation", () => {
  it("materializes a fresh compressed key and the SDK's default script per index", () => {
    const hd = validateHdReceive(config);
    const first = deriveHdReceive(hd, 0);
    const second = deriveHdReceive(hd, 1);
    expect(first.descriptor).toBe(config.descriptor.replace("*", "0"));
    const claim = deriveDescriptorLeafCompressedPubKey(first.descriptor);
    expect(first.claimPublicKey).toBe(Buffer.from(claim).toString("hex"));
    const script = new DefaultVtxo.Script({ pubKey: claim.subarray(1), serverPubKey: Buffer.from(hd.serverPubKey, "hex"), csvTimelock: { type: "seconds", value: 512n } });
    expect(first.arkadeAddress).toBe(script.address("tark", Buffer.from(hd.serverPubKey, "hex")).encode());
    expect(ArkAddress.decode(first.arkadeAddress).pkScript).toEqual(script.pkScript);
    expect(second.claimPublicKey).not.toBe(first.claimPublicKey);
    expect(second.arkadeAddress).not.toBe(first.arkadeAddress);
  });

  it("keys the counter by derivation material, independent of origin and xpub metadata", () => {
    const hd = validateHdReceive(config);
    const changed = Buffer.from(payload);
    changed.fill(3, 5, 13);
    expect(hdReceiveSourceId(validateHdReceive({ ...config, descriptor: `tr([abcdef01/86'/1'/7'/0]${codec.encode(changed)}/*)` }))).toBe(hdReceiveSourceId(hd));
    changed[4] = 5;
    expect(hdReceiveSourceId(validateHdReceive({ ...config, descriptor: `tr([abcdef01/86'/1'/7'/0/0]${codec.encode(changed)}/*)` }))).toBe(hdReceiveSourceId(hd));
    changed[4] = 4;
    changed[13] ^= 1;
    expect(hdReceiveSourceId(validateHdReceive({ ...config, descriptor: `tr([abcdef01/86'/1'/7'/0]${codec.encode(changed)}/*)` }))).not.toBe(hdReceiveSourceId(hd));
  });

  it.each([
    { version: 2 }, { hrp: "ark" }, { serverPubKey: "ff".repeat(32) },
    { descriptor: config.descriptor.replace("/*", "/0/*") },
    { descriptor: config.descriptor + "#12345678" },
    { descriptor: config.descriptor.replace("/0]", "]") },
    { descriptor: config.descriptor.replace("/*", "/1") },
    { descriptor: config.descriptor.replace("tpub", "tprv") },
    { descriptor: "x".repeat(2049) },
    { descriptor: config.descriptor.replace("/0]", "/2147483648]") },
    { exitDelay: { type: "seconds", value: 513 } },
    { exitDelay: { type: "seconds", value: 65536 * 512 } },
    { exitDelay: { type: "blocks", value: 0 } },
    { exitDelay: { type: "blocks", value: 65536 } },
    { exitDelay: { type: "weeks", value: 1 } },
  ])("rejects malformed or unsafe registration %j", (override) => {
    expect(() => validateHdReceive({ ...config, ...override })).toThrow();
  });

  it("rejects hardened and invalid indexes", () => {
    const hd = validateHdReceive(config);
    for (const index of [-1, 0.5, NaN, 2 ** 31]) expect(() => deriveHdReceive(hd, index)).toThrow();
  });

  it("rejects malformed public keys and checksums and accepts matching mainnet branches", () => {
    const broken = Buffer.from(payload);
    broken[45] = 4;
    expect(() => validateHdReceive({ ...config, descriptor: config.descriptor.replace(xpub, codec.encode(broken)) })).toThrow();
    expect(() => validateHdReceive({ ...config, descriptor: config.descriptor.replace(xpub, `${xpub.slice(0, -1)}${xpub.endsWith("1") ? "2" : "1"}`) })).toThrow();
    const mainnet = Buffer.from(payload);
    mainnet.writeUInt32BE(0x0488b21e, 0);
    expect(validateHdReceive({ ...config, hrp: "ark", descriptor: config.descriptor.replace(xpub, codec.encode(mainnet)) }).hrp).toBe("ark");
  });
});
