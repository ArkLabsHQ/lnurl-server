import { ArkAddress } from "@arkade-os/sdk";
import { hex } from "@scure/base";

export const SATORA_OPERATOR_URL = "https://arkade.computer";
// Initial Polygon USDC → Arkade route envelope. The payer applies Satora's live limits.
export const SATORA_CHECKOUT_MIN_SAT = 335;
export const SATORA_CHECKOUT_MAX_SAT = 20_000_000;

export function satoraSignerKey(signer: unknown): string | undefined {
  if (typeof signer !== "string" || !/^(?:0[23])?[\da-f]{64}$/i.test(signer)) return undefined;
  return signer.slice(-64).toLowerCase();
}

export function isSatoraAddress(address: string | null, operatorKey: string | undefined): boolean {
  if (!address || !operatorKey) return false;
  try {
    const decoded = ArkAddress.decode(address);
    return decoded.hrp === "ark" && decoded.version === 0 && hex.encode(decoded.serverPubKey) === operatorKey;
  } catch {
    return false;
  }
}
