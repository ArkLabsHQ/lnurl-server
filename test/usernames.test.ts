import { describe, it, expect } from "vitest";
import { ADJECTIVES, NOUNS, validateUsername, randomUsername } from "../src/usernames.js";

const rules = { usernameMinLen: 1, usernameMaxLen: 32, usernamePattern: "a-z0-9._-" };

describe("validateUsername", () => {
  it("accepts valid names", () => {
    expect(validateUsername("devious", rules)).toBe(true);
    expect(validateUsername("swift-otter_1.2", rules)).toBe(true);
  });
  it("rejects out-of-charset and out-of-length names", () => {
    expect(validateUsername("UPPER", rules)).toBe(false);
    expect(validateUsername("a b", rules)).toBe(false);
    expect(validateUsername("", rules)).toBe(false);
    expect(validateUsername("x".repeat(33), rules)).toBe(false);
  });
});

describe("randomUsername", () => {
  const words = [...ADJECTIVES, ...NOUNS];
  const longest = (list: readonly string[]) => list.reduce((a, b) => (b.length > a.length ? b : a));

  it("draws from distinct lowercase words", () => {
    expect(words.filter((w) => !/^[a-z]+$/.test(w))).toEqual([]);
    expect(words.filter((w, i) => words.indexOf(w) !== i)).toEqual([]);
  });

  it("offers tens of thousands of names", () => {
    expect(ADJECTIVES.length * NOUNS.length).toBeGreaterThan(30_000);
  });

  it("keeps the longest name within the default rules even with its fallback suffix", () => {
    expect(validateUsername(`${longest(ADJECTIVES)}-${longest(NOUNS)}-ffff`, rules)).toBe(true);
  });

  it("produces an adjective-noun name that passes validation", () => {
    for (let i = 0; i < 20; i++) expect(validateUsername(randomUsername(), rules)).toBe(true);
  });
});
