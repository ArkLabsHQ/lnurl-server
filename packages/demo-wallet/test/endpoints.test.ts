import { describe, expect, it } from "vitest";
import {
  ARK_SERVER,
  DEFAULT_ENDPOINTS,
  ENDPOINTS_KEY,
  IS_MAINNET,
  LNURL_BASE,
  LNURL_DOMAIN,
  arkServerWarning,
  clearOverrides,
  lnurlDomainFor,
  normalizeEndpoint,
  readOverrides,
  saveOverrides,
  type KeyValueStore,
} from "../src/config.js";

function fakeStore(initial: Record<string, string> = {}) {
  const entries = new Map<string, string>(Object.entries(initial));
  const store: KeyValueStore = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
  return { store, entries };
}

const planted = (record: unknown) => fakeStore({ [ENDPOINTS_KEY]: JSON.stringify(record) });

describe("normalizeEndpoint", () => {
  it("trims and drops trailing slashes", () => {
    expect(normalizeEndpoint("  https://lnurl.example.com//  ")).toEqual({ ok: true, value: "https://lnurl.example.com" });
  });

  it("keeps a port and a path prefix", () => {
    expect(normalizeEndpoint("http://127.0.0.1:3000/api")).toEqual({ ok: true, value: "http://127.0.0.1:3000/api" });
  });

  it("rejects a bare host with no scheme", () => {
    expect(normalizeEndpoint("lnurl.example.com").ok).toBe(false);
  });

  it("rejects a non-http scheme", () => {
    expect(normalizeEndpoint("ws://lnurl.example.com").ok).toBe(false);
  });

  it("rejects an empty value", () => {
    expect(normalizeEndpoint("   ").ok).toBe(false);
  });
});

describe("saving overrides", () => {
  it("persists only what differs from the default", () => {
    const { store, entries } = fakeStore();

    const result = saveOverrides({ lnurlBase: DEFAULT_ENDPOINTS.lnurlBase, arkServer: "https://ark.signet.example" }, store);

    expect(result).toEqual({ ok: true, overrides: { arkServer: "https://ark.signet.example" } });
    expect(JSON.parse(entries.get(ENDPOINTS_KEY)!)).toEqual({ arkServer: "https://ark.signet.example" });
  });

  it("clears the record when both fields are back to the defaults", () => {
    const { store, entries } = planted({ arkServer: "https://ark.signet.example" });

    saveOverrides(DEFAULT_ENDPOINTS, store);

    expect(entries.has(ENDPOINTS_KEY)).toBe(false);
  });

  it("names the offending field and writes nothing when a URL is invalid", () => {
    const { store, entries } = fakeStore();

    expect(saveOverrides({ arkServer: "not a url" }, store)).toMatchObject({ ok: false, field: "arkServer" });
    expect(entries.has(ENDPOINTS_KEY)).toBe(false);
  });

  it("round-trips through the store", () => {
    const { store } = fakeStore();

    saveOverrides({ lnurlBase: "https://lnurl.signet.example/", arkServer: "https://ark.signet.example" }, store);

    expect(readOverrides(store)).toEqual({
      lnurlBase: "https://lnurl.signet.example",
      arkServer: "https://ark.signet.example",
    });
  });

  it("forgets the overrides on reset", () => {
    const { store, entries } = planted({ arkServer: "https://ark.signet.example" });

    clearOverrides(store);

    expect(entries.has(ENDPOINTS_KEY)).toBe(false);
    expect(readOverrides(store)).toEqual({});
  });
});

describe("reading overrides", () => {
  it("drops a hand-planted value that is not a URL", () => {
    const { store } = planted({ arkServer: "javascript:alert(1)", lnurlBase: "https://lnurl.signet.example" });

    expect(readOverrides(store)).toEqual({ lnurlBase: "https://lnurl.signet.example" });
  });

  it("ignores any field but the two endpoints", () => {
    const { store } = planted({ isMainnet: true, network: "bitcoin", arkServer: "https://ark.signet.example" });

    expect(readOverrides(store)).toEqual({ arkServer: "https://ark.signet.example" });
  });

  it("survives a record that is not an object, or not JSON at all", () => {
    expect(readOverrides(planted("nope").store)).toEqual({});
    expect(readOverrides(fakeStore({ [ENDPOINTS_KEY]: "{oops" }).store)).toEqual({});
  });

  it("reports nothing when there is no record", () => {
    expect(readOverrides(fakeStore().store)).toEqual({});
  });
});

describe("the token audience follows the LNURL base", () => {
  it("derives the domain from an overridden base", () => {
    expect(lnurlDomainFor("https://lnurl.signet.example:8443/api")).toBe("lnurl.signet.example");
  });

  it("leaves the shipped default untouched", () => {
    expect(LNURL_DOMAIN).toBe(lnurlDomainFor(LNURL_BASE));
    expect(LNURL_BASE).toBe(DEFAULT_ENDPOINTS.lnurlBase);
    expect(ARK_SERVER).toBe(DEFAULT_ENDPOINTS.arkServer);
  });
});

describe("the derivation stays pinned", () => {
  it("ships signet, which no override can reach", () => {
    expect(IS_MAINNET).toBe(false);
  });

  it("says nothing about a host that names a non-mainnet network", () => {
    for (const url of [
      "https://mutinynet.arkade.sh",
      "https://ark.signet.example.com",
      "https://regtest.example.com",
      "http://localhost:7070",
      "http://127.0.0.1:7070",
      "http://192.168.1.20:7070",
      "http://arkd:7070",
    ]) {
      expect(arkServerWarning(url), url).toBeNull();
    }
  });

  it("warns on a public host with no such marker", () => {
    expect(arkServerWarning("https://arkade.sh")).toContain("coin type 1");
  });
});
