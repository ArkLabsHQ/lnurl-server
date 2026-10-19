import { browserPaymentStore, createLnurlClient } from "@arkade-os/lnurl-client";
import { arkadeLnurl, bootstrapReceiver, type ArkadeLnurl, type ArkadeLnurlSource, type Receiver } from "@arkade-os/lnurl-client/arkade";
import { LNURL_BASE, LNURL_DOMAIN } from "./config.js";

/** Payer calls resolve against the target's own host, so they need neither a
 *  wallet nor a server of ours. */
export const payer = createLnurlClient();

export function receiverAt(baseUrl: string, domain: string, source: ArkadeLnurlSource): ArkadeLnurl {
  return arkadeLnurl({ ...source, baseUrl, domain, store: browserPaymentStore() });
}

export const receiver = (source: ArkadeLnurlSource): ArkadeLnurl =>
  receiverAt(LNURL_BASE, LNURL_DOMAIN, source);

export { claimOrAdopt } from "@arkade-os/lnurl-client/arkade";

export type BootState = { kind: "ready"; receiver: Receiver } | { kind: "onboard" } | { kind: "unreachable"; error: string };

/** Only "owns nothing" may lead to onboarding: a returning user whose server is down must not be offered a new wallet. */
export const bootState = async (rx: Pick<ArkadeLnurl, "owned" | "capabilities" | "claim">): Promise<BootState> => {
  try {
    const boot = await bootstrapReceiver(rx);
    return boot.kind === "ready" ? { kind: "ready", receiver: boot.receiver } : { kind: "onboard" };
  } catch (e) {
    return { kind: "unreachable", error: (e as Error).message };
  }
};

/** The facade's `capabilities()` without a wallet: onboarding asks before one exists. */
export const domainCapabilities = () =>
  createLnurlClient({ baseUrl: LNURL_BASE }).domainCapabilities({ domain: LNURL_DOMAIN });
