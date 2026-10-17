import { HDKey } from "@scure/bip32";
import { hex } from "@scure/base";
import {
  DefaultVtxo, deriveDescriptorLeafCompressedPubKey, parseHDDescriptor, timelockToSequence,
  type IContractManager,
} from "@arkade-os/sdk";
import { LnurlError } from "./errors.js";
import type { HdReceiveConfig, HdReceiveAllocation } from "./addresses.js";
export type { HdReceiveConfig, HdReceiveAllocation, HdReceiveAllocationPage } from "./addresses.js";

export interface HdReceiveBranch {
  hd: HdReceiveConfig;
  signingDescriptor(index: number): string;
}

const TESTNET_BIP32 = { public: 0x043587cf, private: 0x04358394 };
const INDEX_LIMIT = 0x80000000;

function indexOf(index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= INDEX_LIMIT) {
    throw new LnurlError("HD index must be a non-hardened integer");
  }
  return index;
}

export function createHdReceiveBranch(params: Omit<HdReceiveConfig, "version" | "descriptor"> & {
  accountDescriptor: string;
  branchPath: string;
}): HdReceiveBranch {
  const parsed = parseHDDescriptor(params.accountDescriptor);
  if (!parsed || !params.accountDescriptor.endsWith("/*)") || !/^(xpub|tpub)/.test(parsed.xpub)) {
    throw new LnurlError("accountDescriptor must be a public HD template");
  }
  if (!/^(0|[1-9]\d*)(\/(0|[1-9]\d*))*$/.test(params.branchPath)) {
    throw new LnurlError("branchPath must name a dedicated non-hardened branch below the account xpub");
  }
  const path = params.branchPath.split("/").map(Number);
  path.forEach(indexOf);
  if (path[0] === Number(parsed.derivationPath.split("/")[0]) || path[0] === 1) {
    throw new LnurlError("HD receive must not expose the ordinary receive or change branch");
  }
  const testnet = parsed.xpub.startsWith("tpub");
  if ((params.hrp === "tark") !== testnet) throw new LnurlError("HD descriptor network does not match hrp");
  const node = HDKey.fromExtendedKey(parsed.xpub, testnet ? TESTNET_BIP32 : undefined);
  if (node.depth !== parsed.basePath.split("/").length) throw new LnurlError("HD key origin depth does not match xpub");
  const branch = node.derive(`m/${params.branchPath}`);
  if (branch.depth < 4) throw new LnurlError("HD receive branch must be below account depth");
  const basePath = parsed.basePath.split("/").map((part) => `${Number(part.replace(/['hH]$/, ""))}${/['hH]$/.test(part) ? "'" : ""}`).join("/");
  const fingerprint = parsed.fingerprint.toLowerCase();
  const origin = `${basePath}/${params.branchPath}`;
  const descriptor = `tr([${fingerprint}/${origin}]${branch.publicExtendedKey}/*)`;
  const hd: HdReceiveConfig = {
    version: 1, descriptor, serverPubKey: params.serverPubKey.toLowerCase(), hrp: params.hrp, exitDelay: { ...params.exitDelay },
  };
  const result = {
    hd,
    // Keep the account xpub local: SDK signing ownership compares the embedded xpub.
    signingDescriptor: (index: number) => `tr([${fingerprint}/${basePath}]${parsed.xpub}/${params.branchPath}/${indexOf(index)})`,
  };
  hdReceiveContract(result, 0);
  return result;
}

function hdReceiveContract(branch: HdReceiveBranch, index: number) {
  const hd = branch.hd;
  if (hd.version !== 1 || !/^[0-9a-f]{64}$/i.test(hd.serverPubKey) || !["ark", "tark"].includes(hd.hrp)
    || !["seconds", "blocks"].includes(hd.exitDelay.type)
    || !Number.isSafeInteger(hd.exitDelay.value) || hd.exitDelay.value <= 0) {
    throw new LnurlError("Invalid HD receive script configuration");
  }
  const units = hd.exitDelay.type === "seconds" ? hd.exitDelay.value / 512 : hd.exitDelay.value;
  if (!Number.isInteger(units) || units > 65535) throw new LnurlError("HD receive exit delay is outside BIP68 bounds");
  const descriptor = hd.descriptor.replace("*", String(indexOf(index)));
  const claimPublicKey = deriveDescriptorLeafCompressedPubKey(descriptor);
  const localPublicKey = deriveDescriptorLeafCompressedPubKey(branch.signingDescriptor(index));
  if (hex.encode(claimPublicKey) !== hex.encode(localPublicKey)) throw new LnurlError("HD signing branch does not match receive branch");
  const script = new DefaultVtxo.Script({
    pubKey: claimPublicKey.slice(1), serverPubKey: hex.decode(hd.serverPubKey),
    csvTimelock: { type: hd.exitDelay.type, value: BigInt(hd.exitDelay.value) },
  });
  return { descriptor, claimPublicKey, script, address: script.address(hd.hrp, hex.decode(hd.serverPubKey)).encode() };
}

export async function restoreHdReceiveAllocation(
  manager: Pick<IContractManager, "createContract">,
  allocation: HdReceiveAllocation,
  branch: HdReceiveBranch,
) {
  const hd = branch.hd;
  if (allocation.hd.version !== hd.version || allocation.hd.descriptor !== hd.descriptor
    || allocation.hd.serverPubKey !== hd.serverPubKey || allocation.hd.hrp !== hd.hrp
    || allocation.hd.exitDelay.type !== hd.exitDelay.type || allocation.hd.exitDelay.value !== hd.exitDelay.value) {
    throw new LnurlError("Allocation belongs to a different HD receive configuration");
  }
  const derived = hdReceiveContract(branch, allocation.index);
  if (allocation.descriptor !== derived.descriptor || allocation.arkadeAddress !== derived.address
    || allocation.claimPublicKey !== hex.encode(derived.claimPublicKey)) {
    throw new LnurlError("HD allocation does not match its derived receive script");
  }
  return manager.createContract({
    type: "default", watch: "awaiting-funds", script: hex.encode(derived.script.pkScript), address: derived.address,
    params: {
      pubKey: hex.encode(derived.claimPublicKey.slice(1)), serverPubKey: hd.serverPubKey,
      csvTimelock: timelockToSequence(derived.script.options.csvTimelock).toString(),
    },
    metadata: { signingDescriptor: branch.signingDescriptor(allocation.index) },
  });
}
