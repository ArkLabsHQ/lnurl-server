import { describe, it, expect } from "vitest";
import { createLnurlClient, deriveSessionToken, isValidLnUrl, toPayRequestUrl, LnurlError } from "../src/index.js";

describe("createLnurlClient", () => {
  it("exposes the payer and receiver surface", () => {
    const c = createLnurlClient({ baseUrl: "https://x" });
    for (const m of ["resolve", "requestInvoice", "pollVerify", "openSession",
                     "registerAddress", "listAddresses", "revokeAddress", "registerArkadeIdentity"]) {
      expect(typeof (c as unknown as Record<string, unknown>)[m]).toBe("function");
    }
  });

  it("works with no baseUrl for payer-only use", () => {
    expect(() => createLnurlClient()).not.toThrow();
  });

  it("throws a clear error when a receiver call needs a baseUrl it does not have", async () => {
    const c = createLnurlClient();
    await expect(c.listAddresses("tok")).rejects.toBeInstanceOf(LnurlError);
    await expect(c.listAddresses("tok")).rejects.toThrow(/baseUrl/);
  });

  it("re-exports deriveSessionToken", () => {
    expect(typeof deriveSessionToken).toBe("function");
  });

  // A consumer validates pasted input before it has a client or a baseUrl,
  // so these must be reachable standalone — the wallet's send form and three
  // of its test files import isValidLnUrl on its own today.
  it("exports the encoding helpers standalone", () => {
    expect(isValidLnUrl("alice@arkadeos.com")).toBe(true);
    expect(isValidLnUrl("nonsense")).toBe(false);
    expect(toPayRequestUrl("alice@arkadeos.com")).toEqual({
      url: "https://arkadeos.com/.well-known/lnurlp/alice",
      surface: "address",
    });
  });
});