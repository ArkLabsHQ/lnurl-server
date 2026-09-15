import { describe, it, expect } from "vitest";
import { bech32 } from "@scure/base";
import { isLnAddress, isLnUrl, isValidLnUrl, toPayRequestUrl } from "../src/encoding.js";

const encodeLnurl = (url: string) =>
  bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 1023).toUpperCase();

describe("classification", () => {
  it("recognises a lightning address", () => {
    expect(isLnAddress("alice@arkadeos.com")).toBe(true);
    expect(isLnUrl("alice@arkadeos.com")).toBe(false);
  });

  it("recognises a bech32 lnurl in either case", () => {
    const enc = encodeLnurl("https://x.example/lnurl/abc");
    expect(isLnUrl(enc)).toBe(true);
    expect(isLnUrl(enc.toLowerCase())).toBe(true);
  });

  it("rejects junk", () => {
    expect(isValidLnUrl("not-an-lnurl")).toBe(false);
    expect(isValidLnUrl("lnurl1notvalidbech32")).toBe(false);
  });
});

describe("toPayRequestUrl", () => {
  it("maps user@domain to the well-known address surface", () => {
    expect(toPayRequestUrl("alice@arkadeos.com")).toEqual({
      url: "https://arkadeos.com/.well-known/lnurlp/alice",
      surface: "address",
    });
  });

  it("decodes a session lnurl to the session surface", () => {
    const enc = encodeLnurl("https://x.example/lnurl/deadbeef");
    expect(toPayRequestUrl(enc)).toEqual({ url: "https://x.example/lnurl/deadbeef", surface: "session" });
  });

  it("decodes a long address lnurl and still detects the address surface", () => {
    const target = "https://lnurl.arkadeos.com/.well-known/lnurlp/someverylongusername";
    expect(toPayRequestUrl(encodeLnurl(target))).toEqual({ url: target, surface: "address" });
  });

  it("throws LnurlError on input that is neither", () => {
    expect(() => toPayRequestUrl("nonsense")).toThrow();
  });
});
