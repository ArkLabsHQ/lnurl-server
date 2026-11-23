import { ArkAddress, getNetwork, toXOnlySignerHex } from "@arkade-os/sdk";
import type { Network } from "@arkade-os/solver-discovery";
import { hex } from "@scure/base";

export const MAX_ARKADE_ASSETS = 16;
export const ARKADE_ASSET_OPTION_PREFIX = "arkade-asset:";

export function isArkadeAssetId(value: unknown): value is string {
  return typeof value === "string" && value.length === 68 && !/[^0-9a-f]/.test(value);
}

export function arkadeAssetOptionId(assetId: string): string {
  return ARKADE_ASSET_OPTION_PREFIX + assetId;
}

export function normalizeArkadeAssets(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("arkadeAssets must be an array");
  if (value.length > MAX_ARKADE_ASSETS) throw new Error(`arkadeAssets may have at most ${MAX_ARKADE_ASSETS} entries`);
  const assets = new Set<string>();
  for (const [i, assetId] of value.entries()) {
    if (!isArkadeAssetId(assetId)) throw new Error(`arkadeAssets[${i}] must be a 68-character lowercase hex asset ID`);
    if (assets.has(assetId)) throw new Error(`arkadeAssets[${i}] duplicates an asset ID`);
    assets.add(assetId);
  }
  return [...assets];
}

export function parseArkadeAssets(value: string | null): string[] {
  if (!value) return [];
  try { return normalizeArkadeAssets(JSON.parse(value)); } catch { return []; }
}

export function matchesArkadeAssetDestination(address: string, network: Network, signer?: string): boolean {
  try {
    const decoded = ArkAddress.decode(address);
    return decoded.hrp === getNetwork(network).hrp &&
      (signer === undefined || hex.encode(decoded.serverPubKey) === toXOnlySignerHex(signer.toLowerCase()));
  } catch {
    return false;
  }
}
