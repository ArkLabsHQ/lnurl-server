import { describe, expect, it } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { MNEMONIC_KEY, USERNAME_KEY, type KeyValueStore } from "../src/config.js";
import { checkMnemonic, restoreMnemonic, wipeWallet } from "../src/wallet.js";

function fakeStore(initial: Record<string, string> = {}) {
  const entries = new Map<string, string>(Object.entries(initial));
  const store: KeyValueStore = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
  return { store, entries };
}

// Valid words, failed checksum: the real 12-word "abandon" phrase ends in
// "about", so this is rejected for the reason a mis-ordered phrase is.
const BAD_CHECKSUM = new Array(12).fill("abandon").join(" ");

describe("checkMnemonic", () => {
  it("accepts a generated phrase", () => {
    const mnemonic = generateMnemonic(wordlist);

    expect(checkMnemonic(mnemonic)).toEqual({ ok: true, mnemonic });
  });

  it("normalises pasted casing and whitespace", () => {
    const mnemonic = generateMnemonic(wordlist);
    const pasted = `  ${mnemonic.toUpperCase().split(" ").join("\n  ")} `;

    expect(checkMnemonic(pasted)).toEqual({ ok: true, mnemonic });
  });

  it("rejects an empty input", () => {
    expect(checkMnemonic("   ")).toEqual({ ok: false, error: expect.stringContaining("Enter") });
  });

  it("rejects the wrong number of words, naming the count", () => {
    const result = checkMnemonic("abandon abandon abandon");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("has 3");
  });

  it("rejects a word that is not in the wordlist", () => {
    const mnemonic = generateMnemonic(wordlist).split(" ");
    mnemonic[4] = "zzzz";

    expect(checkMnemonic(mnemonic.join(" ")).ok).toBe(false);
  });

  it("rejects real words whose checksum does not hold", () => {
    expect(checkMnemonic(BAD_CHECKSUM).ok).toBe(false);
  });
});

describe("restoreMnemonic", () => {
  it("stores the normalised phrase", () => {
    const mnemonic = generateMnemonic(wordlist);
    const { store, entries } = fakeStore();

    expect(restoreMnemonic(mnemonic.toUpperCase(), store)).toEqual({ ok: true, mnemonic });
    expect(entries.get(MNEMONIC_KEY)).toBe(mnemonic);
  });

  it("releases the claimed username when the phrase changes", () => {
    const { store, entries } = fakeStore({
      [MNEMONIC_KEY]: generateMnemonic(wordlist),
      [USERNAME_KEY]: "alice",
    });

    restoreMnemonic(generateMnemonic(wordlist), store);

    expect(entries.has(USERNAME_KEY)).toBe(false);
  });

  it("keeps the username when the same phrase is re-entered", () => {
    const mnemonic = generateMnemonic(wordlist);
    const { store, entries } = fakeStore({ [MNEMONIC_KEY]: mnemonic, [USERNAME_KEY]: "alice" });

    restoreMnemonic(`  ${mnemonic}  `, store);

    expect(entries.get(USERNAME_KEY)).toBe("alice");
  });

  it("stores nothing when the phrase does not validate", () => {
    const mnemonic = generateMnemonic(wordlist);
    const { store, entries } = fakeStore({ [MNEMONIC_KEY]: mnemonic, [USERNAME_KEY]: "alice" });

    expect(restoreMnemonic(BAD_CHECKSUM, store).ok).toBe(false);
    expect(entries.get(MNEMONIC_KEY)).toBe(mnemonic);
    expect(entries.get(USERNAME_KEY)).toBe("alice");
  });
});

describe("wipeWallet", () => {
  it("drops this wallet's keys and leaves the rest of the origin alone", async () => {
    const { store, entries } = fakeStore({
      [MNEMONIC_KEY]: generateMnemonic(wordlist),
      [USERNAME_KEY]: "alice",
      "some-other-app": "keep me",
    });

    await wipeWallet(store);

    expect(entries.has(MNEMONIC_KEY)).toBe(false);
    expect(entries.has(USERNAME_KEY)).toBe(false);
    expect(entries.get("some-other-app")).toBe("keep me");
  });
});
