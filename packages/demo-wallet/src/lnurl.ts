import { browserPaymentStore, createLnurlClient } from "@arkade-os/lnurl-client";
import { arkadeLnurl, type ArkadeLnurl, type ArkadeLnurlSource, type ClaimOptions, type Receiver } from "@arkade-os/lnurl-client/arkade";
import { LNURL_BASE, LNURL_DOMAIN } from "./config.js";

/** Payer calls resolve against the target's own host, so they need neither a
 *  wallet nor a server of ours. */
export const payer = createLnurlClient();

export function receiverAt(baseUrl: string, domain: string, source: ArkadeLnurlSource): ArkadeLnurl {
  return arkadeLnurl({ ...source, baseUrl, domain, store: browserPaymentStore() });
}

export const receiver = (source: ArkadeLnurlSource): ArkadeLnurl =>
  receiverAt(LNURL_BASE, LNURL_DOMAIN, source);

/** Asked even with no wallet open: a kept phrase whose wallet failed to open still
 *  owns its address, and claiming again would give the token a second one. */
export const claimOrAdopt = async (rx: ArkadeLnurl, opts: ClaimOptions): Promise<Receiver> =>
  (await rx.owned()) ?? rx.claim(opts);

export type BootState = { kind: "ready"; receiver: Receiver } | { kind: "onboard" } | { kind: "unreachable"; error: string };

/** Only "owns nothing" may lead to onboarding: a returning user whose server is down must not be offered a new wallet. */
export const bootState = async (rx: Pick<ArkadeLnurl, "owned">): Promise<BootState> => {
  try {
    const owned = await rx.owned();
    return owned ? { kind: "ready", receiver: owned } : { kind: "onboard" };
  } catch (e) {
    return { kind: "unreachable", error: (e as Error).message };
  }
};

/** The facade's `capabilities()` without a wallet: onboarding asks before one exists. */
export const domainCapabilities = () =>
  createLnurlClient({ baseUrl: LNURL_BASE }).domainCapabilities({ domain: LNURL_DOMAIN });
