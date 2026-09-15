import { describe, it, expect } from "vitest";
import { createLnurlClient, deriveSessionToken, LnurlError } from "../src/index.js";

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
});