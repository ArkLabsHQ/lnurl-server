import { describe, it, expect, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import type { Wallet } from "@arkade-os/sdk";
import { arkadeLnurl, encodeLnurl, type ArkadeLnurl, type Receiver } from "../src/wallet.js";
import { deriveSessionId } from "../src/token.js";
import { createLnurlClient, type LnurlClient } from "../src/index.js";
import { LnurlError } from "../src/errors.js";

const PRIVATE_KEY = "22".repeat(32);
const ARKADE_ADDRESS =
  "tark1qpf3lesxsy69q0f8yvfnyf7gv7kglfkg83fhaxjyc0zmm0wtrl3n024rshrsa8fnnv73w38094qfl9jp5g7pzdc8j2m58metfpd8rcd37nqs45";
const BOARDING = "tb1qexample";

/** Only the members the facade touches; `router()` is the one path needing more. */
const fakeWallet = (): Wallet => ({
  identity: {
    signMessage: async (message: Uint8Array) => secp256k1.sign(message, hex.decode(PRIVATE_KEY), { prehash: false }),
    compressedPublicKey: async () => secp256k1.getPublicKey(hex.decode(PRIVATE_KEY), true),
  },
  getAddress: async () => ARKADE_ADDRESS,
  getBoardingAddress: async () => BOARDING,
} as unknown as Wallet);

const fakeClient = (over: Partial<LnurlClient> = {}): LnurlClient => ({
  resolve: vi.fn(async () => ({ tag: "payRequest" }) as never),
  requestInvoice: vi.fn(),
  pollVerify: vi.fn(),
  openSession: vi.fn(),
  registerAddress: vi.fn(async () => ({ handle: "alice", username: "alice", lightningAddress: "alice@example.com" }) as never),
  upgradeAddress: vi.fn(async () => ({ handle: "alice", username: "alice", lightningAddress: "alice@example.com" }) as never),
  domainCapabilities: vi.fn(async () => ({
    domain: "lnurl.example.com", allocationModes: ["self", "random"],
    usernameRules: { minLen: 1, maxLen: 20, pattern: ".*" }, requireApiKey: false,
  }) as never),
  listAddresses: vi.fn(async () => []),
  revokeAddress: vi.fn(),
  registerArkadeIdentity: vi.fn(async () => undefined),
  listPayments: vi.fn(async () => ({ payments: [] }) as never),
  ...over,
} as unknown as LnurlClient);

describe("arkadeLnurl", () => {
  it("claims a name and binds the identity in one call", async () => {
    const client = fakeClient();
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });

    const rx = await lnurl.claim({ username: "alice" });

    expect(rx.handle).toBe("alice");
    expect(rx.lightningAddress).toBe("alice@example.com");
    expect(client.registerAddress).toHaveBeenCalledWith({ token: await lnurl.token(), domain: "lnurl.example.com", username: "alice" });
    // The bind is the half that makes offline receive exist; the boarding
    // address rides along so the onchain rail is advertised from the first
    // payRequest rather than needing a second call.
    expect(client.registerArkadeIdentity).toHaveBeenCalledWith(expect.objectContaining({
      handle: "alice",
      arkadeAddress: ARKADE_ADDRESS,
      boardingAddress: BOARDING,
      claimPublicKey: hex.encode(secp256k1.getPublicKey(hex.decode(PRIVATE_KEY), true)),
    }));
  });

  it("sends no username when claiming with no options", async () => {
    const client = fakeClient();
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });

    await lnurl.claim();

    expect(client.registerAddress).toHaveBeenCalledWith({ token: await lnurl.token(), domain: "lnurl.example.com" });
  });

  it("claims namelessly: no lightning address, lnurl at the session id", async () => {
    const wallet = fakeWallet();
    const client = fakeClient({
      registerAddress: vi.fn(async () => ({ handle: "SESSIONID", username: null, lightningAddress: null, sessionLnurl: "LNURL1flagged" }) as never),
    });
    const lnurl = arkadeLnurl({ wallet, baseUrl: "https://lnurl.example.com", client });

    const rx = await lnurl.claim({ nameless: true });

    const sessionId = deriveSessionId(await lnurl.token());
    expect(rx.lightningAddress).toBeUndefined();
    expect(rx.lnurl).toBe(encodeLnurl(`https://lnurl.example.com/lnurl/${sessionId}`));
    expect(client.registerAddress).toHaveBeenCalledWith({ token: await lnurl.token(), domain: "lnurl.example.com", nameless: true });
  });

  it("keeps the session lnurl when a nameless re-claim returns the row it already upgraded", async () => {
    const client = fakeClient({
      registerAddress: vi.fn(async () => ({
        handle: "alice", username: "alice", lightningAddress: "alice@lnurl.example.com", sessionLnurl: "LNURL1flagged",
      }) as never),
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });

    const rx = await lnurl.claim({ nameless: true });

    const sessionId = deriveSessionId(await lnurl.token());
    expect(rx.lnurl).toBe(encodeLnurl(`https://lnurl.example.com/lnurl/${sessionId}`));
    expect(rx.lightningAddress).toBe("alice@lnurl.example.com");
  });

  it("forwards both username and claimCode when claiming a reserved name", async () => {
    const client = fakeClient();
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });

    await lnurl.claim({ username: "alice", claimCode: "code123" });

    expect(client.registerAddress).toHaveBeenCalledWith({
      token: await lnurl.token(), domain: "lnurl.example.com", username: "alice", claimCode: "code123",
    });
  });

  it("will not type a claim code without the name it unlocks", () => {
    const unused = (lnurl: ArkadeLnurl, rx: Receiver) => {
      // @ts-expect-error
      void lnurl.claim({ claimCode: "code123" });
      // @ts-expect-error
      void rx.upgrade({ claimCode: "code123" });
    };
    expect(unused).toBeTypeOf("function");
  });

  it("builds an unflagged receiver's lnurl from baseUrl, which keeps the port", async () => {
    const client = fakeClient();
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "http://127.0.0.1:4283", client });

    const rx = await lnurl.claim({ username: "alice" });

    expect(rx.lnurl).toBe(encodeLnurl("http://127.0.0.1:4283/.well-known/lnurlp/alice"));
  });

  it("addresses its own payRequest through baseUrl, which keeps the port", async () => {
    const client = fakeClient();
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "http://127.0.0.1:4283", client });
    const rx = await lnurl.claim({ username: "alice" });

    await rx.payRequest();

    expect(client.resolve).toHaveBeenCalledWith(encodeLnurl("http://127.0.0.1:4283/.well-known/lnurlp/alice"));
  });

  it("derives the session token once, however often it is asked", async () => {
    const wallet = fakeWallet();
    const signMessage = vi.spyOn(wallet.identity, "signMessage");
    const lnurl = arkadeLnurl({ wallet, baseUrl: "https://lnurl.example.com", client: fakeClient() });

    const [a, b] = await Promise.all([lnurl.token(), lnurl.token()]);

    expect(a).toBe(b);
    // Twice, not once: deriveSessionTokenWithSigner signs twice to prove the
    // signer is deterministic. The point is that a second call adds none.
    expect(signMessage).toHaveBeenCalledTimes(2);
  });

  it("reports the active address this wallet already owns", async () => {
    const client = fakeClient({
      listAddresses: vi.fn(async () => [
        { handle: "old", username: "old", lightningAddress: "old@x", status: "revoked", sessionLnurl: null, domain: "lnurl.example.com" },
        { handle: "current", username: "current", lightningAddress: "current@x", status: "active", sessionLnurl: null, domain: "lnurl.example.com" },
      ]) as never,
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });
    expect((await lnurl.owned())?.handle).toBe("current");
  });

  it("owned() prefers the flagged entry among active ones", async () => {
    const client = fakeClient({
      listAddresses: vi.fn(async () => [
        { handle: "bob", username: "bob", lightningAddress: "bob@x", status: "active", sessionLnurl: null, domain: "lnurl.example.com" },
        { handle: "SESSIONID", username: null, lightningAddress: null, status: "active", sessionLnurl: "LNURL1flagged", domain: "lnurl.example.com" },
      ]) as never,
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });

    const rx = await lnurl.owned();

    expect(rx?.handle).toBe("SESSIONID");
    expect(rx?.lightningAddress).toBeUndefined();
  });

  it("returns undefined when the token owns nothing", async () => {
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client: fakeClient() });
    expect(await lnurl.owned()).toBeUndefined();
  });

  it("upgrades a nameless receiver, keeping its lnurl but gaining an address", async () => {
    const wallet = fakeWallet();
    const client = fakeClient({
      registerAddress: vi.fn(async () => ({ handle: "SESSIONID", username: null, lightningAddress: null, sessionLnurl: "LNURL1flagged" }) as never),
      upgradeAddress: vi.fn(async () => ({ handle: "alice", username: "alice", lightningAddress: "alice@lnurl.example.com" }) as never),
    });
    const lnurl = arkadeLnurl({ wallet, baseUrl: "https://lnurl.example.com", client });
    const nameless = await lnurl.claim({ nameless: true });

    const named = await nameless.upgrade({ username: "alice" });

    expect(client.upgradeAddress).toHaveBeenCalledWith({
      token: await lnurl.token(), handle: "SESSIONID", domain: "lnurl.example.com", username: "alice",
    });
    expect(named.lnurl).toBe(nameless.lnurl);
    expect(named.lightningAddress).toBe("alice@lnurl.example.com");
  });

  // A script, a test or a server may hold only a key. Receiving needs a signer
  // and an address; only spending the wallet's own coins needs the wallet.
  it("claims with an identity and an address, no wallet", async () => {
    const client = fakeClient();
    const wallet = fakeWallet();
    const lnurl = arkadeLnurl({
      identity: wallet.identity,
      arkadeAddress: ARKADE_ADDRESS,
      baseUrl: "https://lnurl.example.com",
      client,
    });

    await lnurl.claim({ username: "alice" });

    expect(client.registerArkadeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ arkadeAddress: ARKADE_ADDRESS }),
    );
    // Omitted rather than sent as undefined: the onchain rail is advertised
    // only where a boarding address was actually registered.
    expect(client.registerArkadeIdentity).toHaveBeenCalledWith(
      expect.not.objectContaining({ boardingAddress: expect.anything() }),
    );
  });

  it("says a wallet is needed before it fails somewhere obscure", () => {
    const lnurl = arkadeLnurl({
      identity: fakeWallet().identity,
      arkadeAddress: ARKADE_ADDRESS,
      baseUrl: "https://lnurl.example.com",
      client: fakeClient(),
    });
    expect(() => lnurl.router()).toThrow(/needs a wallet/);
  });

  it("says what is missing when sync has nowhere to write", async () => {
    const client = fakeClient();
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });
    const rx = await lnurl.claim({ username: "alice" });
    await expect(rx.sync()).rejects.toThrow(LnurlError);
  });

  it("scopes a payments query to its own domain", async () => {
    const client = fakeClient();
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });
    const rx = await lnurl.claim({ username: "alice" });

    await rx.payments({ limit: 10 });

    expect(client.listPayments).toHaveBeenCalledWith(
      await lnurl.token(), "alice", { domain: "lnurl.example.com", limit: 10 },
    );
  });

  it("owned() considers only entries on the facade's own domain", async () => {
    const client = fakeClient({
      listAddresses: vi.fn(async () => [
        { handle: "SESSIONID", username: null, lightningAddress: null, status: "active", sessionLnurl: "LNURL1x", domain: "other.example" },
        { handle: "elsewhere", username: "elsewhere", lightningAddress: "elsewhere@other.example", status: "active", sessionLnurl: null, domain: "other.example" },
        { handle: "here", username: "here", lightningAddress: "here@lnurl.example.com", status: "active", sessionLnurl: null, domain: "lnurl.example.com" },
      ]) as never,
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });
    expect((await lnurl.owned())?.handle).toBe("here");
    const mixedCase = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", domain: "LNURL.example.com", client });
    expect((await mixedCase.owned())?.handle).toBe("here");

    const onlyOther = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", domain: "third.example", client });
    expect(await onlyOther.owned()).toBeUndefined();
  });

  it("sends its configured domain when claiming, binding and upgrading", async () => {
    const client = fakeClient({
      registerAddress: vi.fn(async () => ({ handle: "SESSIONID", username: null, lightningAddress: null, sessionLnurl: "LNURL1flagged" }) as never),
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", domain: "pay.example", client });

    const rx = await lnurl.claim({ nameless: true });
    await rx.upgrade({ username: "alice" });

    expect(client.registerAddress).toHaveBeenCalledWith(expect.objectContaining({ domain: "pay.example" }));
    expect(client.registerArkadeIdentity).toHaveBeenCalledWith(expect.objectContaining({ domain: "pay.example" }));
    expect(client.upgradeAddress).toHaveBeenCalledWith(expect.objectContaining({ domain: "pay.example" }));
  });

  it("defaults capabilities() to the facade's own domain", async () => {
    const client = fakeClient();
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });

    await lnurl.capabilities();

    expect(client.domainCapabilities).toHaveBeenCalledWith({ domain: "lnurl.example.com" });
  });
});

describe("arkadeLnurl against a server predating nameless receivers", () => {
  const BASE = "https://lnurl.example.com";
  const legacy = { username: "alice", domain: "lnurl.example.com", status: "active", lightningAddress: "alice@lnurl.example.com", lnurl: "LNURL1OLD" };

  const oldServer = () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      const body = init?.method === "POST" && url.endsWith("/lnurl/address") ? legacy
        : url.endsWith("/arkade") ? { ok: true }
        : [{ ...legacy, createdAt: 1 }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    return { calls, client: createLnurlClient({ baseUrl: BASE, fetchImpl: fetchImpl as never }) };
  };

  it("owned() falls back to the username as handle and the .well-known lnurl", async () => {
    const { client } = oldServer();
    const rx = await arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client }).owned();

    expect(rx).toMatchObject({
      handle: "alice",
      lightningAddress: "alice@lnurl.example.com",
      lnurl: encodeLnurl(`${BASE}/.well-known/lnurlp/alice`),
    });
  });

  it("claim() binds the identity at the username", async () => {
    const { calls, client } = oldServer();
    const rx = await arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client }).claim({ username: "alice" });

    expect(rx.handle).toBe("alice");
    expect(calls).toContain("POST /lnurl/address/alice/arkade");
  });

  it("claim({ nameless }) refuses the name it ignored nameless to allocate, and binds nothing", async () => {
    const { calls, client } = oldServer();
    const claiming = arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client }).claim({ nameless: true });

    await expect(claiming).rejects.toThrow(LnurlError);
    await expect(claiming).rejects.toThrow(/alice/);
    expect(calls).not.toContain("POST /lnurl/address/alice/arkade");
  });
});
