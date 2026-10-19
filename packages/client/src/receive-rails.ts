import { ArkAddress } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { LnurlError } from "./errors.js";
import { createLnurlClient, type LnurlClient } from "./index.js";
import type { PayRequest, PaymentOption } from "./types.js";
import type { Receiver } from "./wallet.js";

export type LnurlRailType = "lightning" | "arkade" | "onchain";

export function lnurlRailLimits(payRequest: PayRequest): { type: string; min: number; max: number }[] {
  const options: PaymentOption[] = payRequest.paymentOptions ?? [{ id: "lightning", type: "lightning" }];
  return options
    .filter((option) => option.id !== "" && option.available !== false && option.asset === undefined)
    .map((option) => ({
      type: option.type,
      min: Math.ceil((option.minSendable ?? payRequest.minSendable) / 1000),
      max: Math.floor((option.maxSendable ?? payRequest.maxSendable) / 1000),
    }));
}

function sameOperator(a: string, b: string): boolean {
  try {
    const [x, y] = [ArkAddress.decode(a), ArkAddress.decode(b)];
    return x.hrp === y.hrp && hex.encode(x.serverPubKey) === hex.encode(y.serverPubKey);
  } catch {
    return false;
  }
}

export async function resolveLnurlRails(
  receiver: Pick<Receiver, "payRequest">,
  amountSat: number,
  rails: readonly LnurlRailType[],
  own: { arkade: string; onchain: string },
  client: Pick<LnurlClient, "requestInvoice"> = createLnurlClient(),
): Promise<PromiseSettledResult<string>[]> {
  const payRequest = await receiver.payRequest();
  return Promise.allSettled(rails.map(async (rail) => {
    const option = payRequest.paymentOptions?.find((candidate) =>
      candidate.id !== "" && candidate.type === rail && candidate.available !== false && candidate.asset === undefined);
    const legacyLightning = payRequest.paymentOptions === undefined && rail === "lightning";
    if (!option && !legacyLightning) throw new LnurlError(`the LNURL offers no ${rail} rail`);
    const min = option?.minSendable ?? payRequest.minSendable;
    const max = option?.maxSendable ?? payRequest.maxSendable;
    const amountMsat = amountSat * 1000;
    if (!Number.isSafeInteger(amountMsat) || amountMsat < min || amountMsat > max) {
      throw new LnurlError(`Amount must be between ${min} and ${max} whole millisats`);
    }
    const result = await client.requestInvoice(payRequest, { amountSat, paymentOption: option?.id });
    if (option && result.paymentOption !== undefined && result.paymentOption !== option.id) {
      throw new LnurlError(`The callback answered for ${result.paymentOption}, not ${option.id}`);
    }
    const target = result.kind === "bolt11" ? result.pr : result.paymentDestination;
    if (!target || (result.kind === "bolt11") !== (rail === "lightning")) {
      throw new LnurlError(`the LNURL answered the ${rail} rail with nothing payable on it`);
    }
    if (rail === "onchain" && target !== own.onchain) {
      throw new LnurlError("the LNURL gave an on-chain address that is not this wallet's");
    }
    // Matching the operator and network does not prove this wallet owns the recipient.
    if (rail === "arkade" && !sameOperator(target, own.arkade)) {
      throw new LnurlError("the LNURL gave an Arkade address on another operator");
    }
    return target;
  }));
}
