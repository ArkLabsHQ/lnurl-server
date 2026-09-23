/** Quotes a Nitro attestation document carrying exactly this nonce and user data. Production
 *  quotes through the NSM helper (nsm-attestor.ts), which is unvalidated until it runs on Nitro. */
export interface EnclaveAttestor {
  quote(input: { nonce: Uint8Array; userData: Uint8Array }): Promise<Uint8Array>;
}
