/** Mutinynet endpoints. The LNURL domain is also the token's audience, so it
 *  must match the host that serves the address, not the API base. */
export const LNURL_BASE = "https://lnurl.mutinynet.arkade.sh";
export const LNURL_DOMAIN = "lnurl.mutinynet.arkade.sh";
export const ARK_SERVER = "https://mutinynet.arkade.sh";
export const NETWORK = "mutinynet" as const;
/** Decides the identity's BIP44 coin type. The Arkade Service refuses a wallet
 *  whose derivation disagrees with its own network, so this is not cosmetic:
 *  mainnet derivation (coin type 0) against mutinynet fails wallet creation
 *  outright. */
export const IS_MAINNET = false;
export const EXPLORER = "https://explorer.mutinynet.arkade.sh";

export const MNEMONIC_KEY = "arkade-demo-wallet.mnemonic";
export const USERNAME_KEY = "arkade-demo-wallet.username";
