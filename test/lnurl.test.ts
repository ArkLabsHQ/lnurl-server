import { describe, it, expect } from "vitest";
import { bech32 } from "@scure/base";
import { encodeLnurl } from "../src/lnurl.js";

describe("encodeLnurl", () => {
  it("bech32-encodes a URL as an uppercase lnurl", () => {
    const url = "https://domain.com/.well-known/lnurlp/devious";
    const lnurl = encodeLnurl(url);
    expect(lnurl).toMatch(/^LNURL1[A-Z0-9]+$/);
    const decoded = bech32.decode(lnurl.toLowerCase() as `lnurl1${string}`, 1023);
    expect(new TextDecoder().decode(bech32.fromWords(decoded.words))).toBe(url);
  });
});
