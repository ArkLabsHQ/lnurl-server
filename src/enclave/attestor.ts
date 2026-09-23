/** Quotes a Nitro attestation document carrying exactly this nonce and user data. Nothing
 *  implements it yet: the NSM helper it needs has to be validated on real Nitro first. */
export interface EnclaveAttestor {
  quote(input: { nonce: Uint8Array; userData: Uint8Array }): Promise<Uint8Array>;
}
