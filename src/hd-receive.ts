import { DefaultVtxo, deriveDescriptorLeafCompressedPubKey, parseHDDescriptor } from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { createBase58check } from "@scure/base";

export interface HdReceiveConfig {
  version: 1;
  descriptor: string;
  serverPubKey: string;
  hrp: "ark" | "tark";
  exitDelay: { type: "seconds" | "blocks"; value: number };
}

export interface HdReceiveAllocation {
  id: number;
  index: number;
  descriptor: string;
  arkadeAddress: string;
  claimPublicKey: string;
  hd: HdReceiveConfig;
  createdAt: number;
}

const codec = createBase58check(sha256);
const descriptorPattern = /^tr\(\[([0-9a-fA-F]{8})((?:\/[0-9]+['hH]?){4,})\]((?:xpub|tpub)[1-9A-HJ-NP-Za-km-z]+)\/\*\)$/;

export function validateHdReceive(value: unknown): HdReceiveConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid HD receive configuration");
  const v = value as Partial<HdReceiveConfig>;
  if (v.version !== 1 || (v.hrp !== "ark" && v.hrp !== "tark")) throw new Error("unsupported HD receive version or network");
  const match = typeof v.descriptor === "string" && v.descriptor.length <= 2048 ? descriptorPattern.exec(v.descriptor) : null;
  if (!match) throw new Error("HD receive requires a scoped public branch descriptor");
  const path = match[2].slice(1).split("/");
  if (path.some((segment) => Number(segment.replace(/['hH]$/, "")) >= 2 ** 31)) throw new Error("invalid descriptor origin index");
  const payload = codec.decode(match[3]);
  if (payload.length !== 78 || payload[4] !== path.length) throw new Error("descriptor origin does not match public branch depth");
  const version = Buffer.from(payload).readUInt32BE(0);
  if (version !== (v.hrp === "ark" ? 0x0488b21e : 0x043587cf)) throw new Error("HD public branch network mismatch");
  secp256k1.Point.fromBytes(payload.subarray(45));
  if (typeof v.serverPubKey !== "string" || !/^[0-9a-fA-F]{64}$/.test(v.serverPubKey)) throw new Error("invalid HD receive server public key");
  secp256k1.Point.fromBytes(Buffer.from(`02${v.serverPubKey}`, "hex"));
  const delay = v.exitDelay;
  if (!delay || !Number.isSafeInteger(delay.value) || (delay.type !== "seconds" && delay.type !== "blocks")) throw new Error("invalid HD receive exit delay");
  const units = delay.type === "seconds" ? delay.value / 512 : delay.value;
  if (!Number.isInteger(units) || units < 1 || units > 65535) throw new Error("HD receive exit delay is outside BIP68 bounds");
  const descriptor = `tr([${match[1].toLowerCase()}/${path.map((p) => `${Number(p.replace(/['hH]$/, ""))}${/['hH]$/.test(p) ? "'" : ""}`).join("/")}]${match[3]}/*)`;
  if (!parseHDDescriptor(descriptor.replace("*", "0"))) throw new Error("unparseable HD receive descriptor");
  return { version: 1, descriptor, serverPubKey: v.serverPubKey.toLowerCase(), hrp: v.hrp, exitDelay: { type: delay.type, value: delay.value } };
}

export function hdReceiveSourceId(hd: HdReceiveConfig): string {
  const normalized = validateHdReceive(hd);
  const payload = codec.decode(descriptorPattern.exec(normalized.descriptor)![3]);
  return Buffer.from(sha256(payload.subarray(13))).toString("hex");
}

export function deriveHdReceive(hd: HdReceiveConfig, index: number): Pick<HdReceiveAllocation, "descriptor" | "arkadeAddress" | "claimPublicKey"> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** 31) throw new Error("HD receive index exhausted or invalid");
  const config = validateHdReceive(hd);
  const descriptor = config.descriptor.replace("*", String(index));
  const claimPublicKey = deriveDescriptorLeafCompressedPubKey(descriptor);
  const serverPubKey = Buffer.from(config.serverPubKey, "hex");
  const script = new DefaultVtxo.Script({ pubKey: claimPublicKey.subarray(1), serverPubKey, csvTimelock: { type: config.exitDelay.type, value: BigInt(config.exitDelay.value) } });
  return { descriptor, claimPublicKey: Buffer.from(claimPublicKey).toString("hex"), arkadeAddress: script.address(config.hrp, serverPubKey).encode() };
}
