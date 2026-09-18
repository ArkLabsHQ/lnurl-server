import { MnemonicIdentity, RestArkProvider, Wallet, type WalletBalance } from "@arkade-os/sdk";
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ARK_SERVER, MNEMONIC_KEY } from "./config.js";

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

/**
 * Opens the SDK wallet for a mnemonic.
 *
 * No `storage` is passed: the SDK defaults to IndexedDB, which exists here and
 * is why this demo is a browser app rather than a script.
 */
export async function openWallet(mnemonic: string): Promise<DemoWallet> {
  const identity = MnemonicIdentity.fromMnemonic(mnemonic);
  const wallet = await Wallet.create({ identity, arkProvider: new RestArkProvider(ARK_SERVER) });
  const [offchain, boarding] = await wallet.getNewAddresses({ types: ["default", "boarding"] });
  return { identity, wallet, arkadeAddress: offchain.address, boardingAddress: boarding.address };
}

export function getBalance(wallet: Wallet): Promise<WalletBalance> {
  return wallet.getBalance();
}

export function sendToArkadeAddress(wallet: Wallet, address: string, amountSats: number): Promise<string> {
  return wallet.send({ recipients: [{ address, amount: amountSats }] });
}
