import { browserPaymentStore, createLnurlClient } from "@arkade-os/lnurl-client";
import { arkadeLnurl, encodeLnurl, type ArkadeLnurl, type ArkadeLnurlSource } from "@arkade-os/lnurl-client/arkade";
import { LNURL_BASE, LNURL_DOMAIN } from "./config.js";

/** Payer calls resolve against the target's own host, so they need neither a
 *  wallet nor a server of ours. */
export const payer = createLnurlClient();

export function receiverAt(baseUrl: string, domain: string, source: ArkadeLnurlSource): ArkadeLnurl {
  return arkadeLnurl({ ...source, baseUrl, domain, store: browserPaymentStore() });
}

export const receiver = (source: ArkadeLnurlSource): ArkadeLnurl =>
  receiverAt(LNURL_BASE, LNURL_DOMAIN, source);

/** Our own address, addressed through the base rather than the LUD-16 domain,
 *  which drops the port. Needs no identity: it only resolves an LNURL. */
export const ownPayRequest = (username: string) =>
  payer.resolve(encodeLnurl(`${LNURL_BASE}/.well-known/lnurlp/${username.toLowerCase()}`));
