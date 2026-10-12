import { describe, it, expect } from "vitest";
import { createLnurlClient, deriveSessionToken, isValidLnUrl, toPayRequestUrl, LnurlError } from "../src/index.js";

describe("createLnurlClient", () => {
  it("exposes the payer and receiver surface", () => {
    const c = createLnurlClient({ baseUrl: "https://x" });
    for (const m of ["resolve", "requestInvoice", "pollVerify", "openSession",
                     "registerAddress", "listAddresses", "revokeAddress", "registerArkadeIdentity",
                     "upgradeAddress", "domainCapabilities"]) {
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

  // React Native has no readable response.body on its global fetch, so Expo
  // consumers must inject expo/fetch — whose signature is not identical to the
  // DOM one. If FetchImpl narrows back to `typeof globalThis.fetch`, this stops
  // compiling and they are forced into an `as unknown as` cast.
  it("accepts a structurally-different fetch, as expo/fetch requires", async () => {
    const expoStyleFetch = (input: string | { toString(): string }, init?: RequestInit): Promise<Response> => {
      void input;
      void init;
      return Promise.resolve(
        new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }),
      );
    };
    const client = createLnurlClient({ baseUrl: "https://x", fetchImpl: expoStyleFetch });
    await expect(client.listAddresses("tok")).resolves.toEqual([]);
  });

  // A client built at module scope is constructed before a test installs its
  // fetch mock. Binding globalThis.fetch once at construction would capture the
  // real one and ignore the mock, which fails silently and looks like a network
  // bug rather than a wiring bug.
  it("uses a global fetch installed after the client was created", async () => {
    const client = createLnurlClient({ baseUrl: "https://x" });
    const original = globalThis.fetch;
    let seen = "";
    globalThis.fetch = (async (url: string) => {
      seen = String(url);
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    try {
      await client.listAddresses("tok");
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toBe("https://x/lnurl/address");
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