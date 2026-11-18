import { ArkAddress } from "@arkade-os/sdk";
import { hex } from "@scure/base";

export const SATORA_OPERATOR_URL = "https://arkade.computer";
export const SATORA_PAYMENT_OPTION = "satora-usdcpolygon";
export const SATORA_OPTION_PREFIX = "satora-";
export const SATORA_CHECKOUT_MIN_SAT = 335;
export const SATORA_CHECKOUT_MAX_SAT = 20_000_000;

export interface SatoraCheckout {
  isAvailable?(optionId: string): boolean;
  create(input: {
    optionId: string;
    addressId: number;
    verifyId: string;
    amountSat: number;
    deriveRecipient(): Promise<{ address: string; script: string }>;
  }): Promise<{
    swapId: string;
    depositAddress: string;
    sourceAmount: string;
    expiresAt: number;
    covenantScript: string;
  }>;
  activate(swapId: string): void;
}

export class SatoraCapacityError extends Error {}

export const isSatoraPaymentOption = (optionId: string | null | undefined): boolean =>
  optionId?.startsWith(SATORA_OPTION_PREFIX) === true;

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
