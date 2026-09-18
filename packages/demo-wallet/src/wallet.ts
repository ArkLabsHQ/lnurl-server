import { MnemonicIdentity, RestArkProvider, Wallet, type WalletBalance } from "@arkade-os/sdk";
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ARK_SERVER, browserStore, IS_MAINNET, MNEMONIC_KEY, USERNAME_KEY, type KeyValueStore } from "./config.js";

export interface DemoWallet {
  identity: MnemonicIdentity;
  wallet: Wallet;
  arkadeAddress: string;
  boardingAddress: string;
}

export function loadMnemonic(): string | null {
  const stored = localStorage.getItem(MNEMONIC_KEY);
  return stored && validateMnemonic(stored, wordlist) ? stored : null;
}

export function createMnemonic(): string {
  const mnemonic = generateMnemonic(wordlist);
  localStorage.setItem(MNEMONIC_KEY, mnemonic);
  return mnemonic;
}

export function forgetWallet(): void {
  localStorage.clear();
}

export type MnemonicCheck = { ok: true; mnemonic: string } | { ok: false; error: string };

const WORD_COUNTS = [12, 15, 18, 21, 24];

export function checkMnemonic(input: string): MnemonicCheck {
  const mnemonic = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!mnemonic) return { ok: false, error: "Enter your recovery phrase." };
  const count = mnemonic.split(" ").length;
  if (!WORD_COUNTS.includes(count)) {
    return { ok: false, error: `A recovery phrase is 12 or 24 words; this one has ${count}.` };
  }
  if (!validateMnemonic(mnemonic, wordlist)) {
    return { ok: false, error: "Not a valid BIP39 phrase — a word is mistyped or out of order." };
  }
  return { ok: true, mnemonic };
}

/** Adopts a pasted phrase, storing nothing when it fails the check. */
export function restoreMnemonic(input: string, store: KeyValueStore = browserStore()): MnemonicCheck {
  const checked = checkMnemonic(input);
  if (!checked.ok) return checked;
  // The claimed username belongs to the key that registered it — the session
  // token is derived from that key — so a different phrase has to release it
  // rather than show an address this wallet can no longer prove it owns.
  if (store.getItem(MNEMONIC_KEY) !== checked.mnemonic) store.removeItem(USERNAME_KEY);
  store.setItem(MNEMONIC_KEY, checked.mnemonic);
  return checked;
}

/** Drops this wallet's keys only, where `forgetWallet` clears the whole origin
 *  — on a Pages host that is shared with every other app served from it. */
export function wipeWallet(store: KeyValueStore = browserStore()): void {
  store.removeItem(MNEMONIC_KEY);
  store.removeItem(USERNAME_KEY);
}

/**
 * Opens the SDK wallet for a mnemonic.
 *
 * No `storage` is passed: the SDK defaults to IndexedDB, which exists here and
 * is why this demo is a browser app rather than a script.
 */
export async function openWallet(mnemonic: string): Promise<DemoWallet> {
  const identity = MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet: IS_MAINNET });
  const wallet = await Wallet.create({ identity, arkProvider: new RestArkProvider(ARK_SERVER) });
  const [offchain, boarding] = await wallet.getNewAddresses({ types: ["default", "boarding"] });
  return { identity, wallet, arkadeAddress: offchain.address, boardingAddress: boarding.address };
}

export function getBalance(wallet: Wallet): Promise<WalletBalance> {
  return wallet.getBalance();
}
