import {
  IndexedDBContractRepository,
  IndexedDBWalletRepository,
  MnemonicIdentity,
  RestArkProvider,
  Wallet,
  type WalletBalance,
} from "@arkade-os/sdk";
import { IndexedDbAssetSwapRepository, type SwapClient } from "@arkade-os/swap";
import { hex } from "@scure/base";
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ARK_SERVER, browserStore, IS_MAINNET, MNEMONIC_KEY, STORE_OWNER_KEY, USERNAME_KEY, type KeyValueStore } from "./config.js";
import { createSwaps } from "./lightning.js";

export interface DemoWallet {
  identity: MnemonicIdentity;
  wallet: Wallet;
  swaps: SwapClient;
  arkadeAddress: string;
  boardingAddress: string;
}

// The open wallet's; disposed before another opens or its data is cleared, so no drive outlives its identity.
let openSwaps: SwapClient | undefined;

async function closeSwaps(): Promise<void> {
  const swaps = openSwaps;
  openSwaps = undefined;
  await swaps?.[Symbol.asyncDispose]();
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

/** Drops the SDK's cached chain data. Its IndexedDB is keyed by database name, not
 *  by identity, so a new key otherwise inherits the previous wallet's VTXOs, swaps and
 *  contracts — which it cannot sign (`MissingSigningDescriptorError`). */
export async function clearWalletData(): Promise<void> {
  await closeSwaps();
  // Absent under Node; a real browser failure still propagates.
  if (typeof indexedDB === "undefined") return;
  await Promise.all([
    new IndexedDBWalletRepository().clear(),
    new IndexedDBContractRepository().clear(),
    new IndexedDbAssetSwapRepository().clear(),
  ]);
}

/** Drops this wallet's keys only, where `forgetWallet` clears the whole origin
 *  — on a Pages host that is shared with every other app served from it. */
export async function wipeWallet(store: KeyValueStore = browserStore()): Promise<void> {
  store.removeItem(MNEMONIC_KEY);
  store.removeItem(USERNAME_KEY);
  store.removeItem(STORE_OWNER_KEY);
  await clearWalletData();
}

/**
 * Opens the SDK wallet for a mnemonic.
 *
 * No `storage` is passed: the SDK defaults to IndexedDB, which exists here and
 * is why this demo is a browser app rather than a script.
 */
export async function openWallet(mnemonic: string, store: KeyValueStore = browserStore()): Promise<DemoWallet> {
  const identity = MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet: IS_MAINNET });
  // One identity's chain data at a time; cleared before the wallet opens.
  const owner = hex.encode(await identity.xOnlyPublicKey());
  await closeSwaps();
  if (store.getItem(STORE_OWNER_KEY) !== owner) {
    await clearWalletData();
    store.setItem(STORE_OWNER_KEY, owner);
  }
  const wallet = await Wallet.create({ identity, arkProvider: new RestArkProvider(ARK_SERVER) });
  const swaps = createSwaps(wallet);
  openSwaps = swaps;
  // The restore read: a reload resumes a swap the last session left funded.
  swaps.ready.catch((e: unknown) => console.error("swap restore failed; swaps from an earlier session will not resume:", e));
  const [offchain, boarding] = await wallet.getNewAddresses({ types: ["default", "boarding"] });
  return { identity, wallet, swaps, arkadeAddress: offchain.address, boardingAddress: boarding.address };
}

export function getBalance(wallet: Wallet): Promise<WalletBalance> {
  return wallet.getBalance();
}
