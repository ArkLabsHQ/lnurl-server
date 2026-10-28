import { afterEach, describe, it, expect, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { createDefaultPaymentRouter, invoiceTarget, type PaymentRail, type RouteQuote, type Wallet } from "@arkade-os/sdk";
import { arkadeLnurl, arkadePaymentRouter, DEFAULT_RAIL_PRIORITY, encodeLnurl } from "../src/wallet.js";
import { deriveSessionId } from "../src/token.js";
import { createLnurlClient, type LnurlClient } from "../src/index.js";
import { LnurlError } from "../src/errors.js";
import type { PaymentMethod } from "../src/addresses.js";
import { PAY_REQUEST_TTL_MS } from "../src/rail.js";

const PRIVATE_KEY = "22".repeat(32);
const ARKADE_ADDRESS =
  "tark1qpf3lesxsy69q0f8yvfnyf7gv7kglfkg83fhaxjyc0zmm0wtrl3n024rshrsa8fnnv73w38094qfl9jp5g7pzdc8j2m58metfpd8rcd37nqs45";
const BOARDING = "tb1qexample";
const METHOD = { type: "shielded", destination: "shrol21abc" };
const OTHER = { type: "nostr", destination: "npub1abc" };

/** Only the members the facade touches; `router()` is the one path needing more. */
const fakeWallet = () => ({
  identity: {
    signMessage: async (message: Uint8Array) => secp256k1.sign(message, hex.decode(PRIVATE_KEY), { prehash: false }),
    compressedPublicKey: async () => secp256k1.getPublicKey(hex.decode(PRIVATE_KEY), true),
  },
  getAddress: async () => ARKADE_ADDRESS,
  getBoardingAddress: async () => BOARDING,
});

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
  it("uses a structural router supplied by the caller", async () => {
    const sdkRouter = createDefaultPaymentRouter(fakeWallet() as unknown as Wallet);
    sdkRouter.use({
      id: "custom",
      match: (req) => req.raw === "custom:payment",
      quote: async () => ({
        railId: "custom", amount: 500, fee: 7, total: 507,
        send: async () => { throw new Error("This test quotes without spending"); },
      }),
    });
    const router = {
      use(rail: PaymentRail) { sdkRouter.use(rail); return this; },
      remove(id: string) { sdkRouter.remove(id); return this; },
      options: sdkRouter.options.bind(sdkRouter),
      route: sdkRouter.route.bind(sdkRouter),
    };
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", router });

    expect((await lnurl.options("custom:payment", 500)).map((option) => option.railId)).toEqual(["custom"]);
    expect(await lnurl.router().route({ raw: "custom:payment", amount: 500 })).toMatchObject({ amount: 500, total: 507 });

    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      tag: "payRequest", callback: "https://lnurl.example.com/callback",
      minSendable: 1000, maxSendable: 1_000_000, metadata: '[["text/plain","alice"]]',
      paymentOptions: [{ id: "arkade", type: "arkade" }],
    })));
    try {
      expect((await lnurl.options("alice@lnurl.example.com", 500)).map((option) => option.railId)).toEqual(["lnurl-arkade"]);
    } finally {
      fetch.mockRestore();
    }
  });

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

  it("names its session lnurl before any address is claimed, as the nameless claim will serve it", async () => {
    const client = fakeClient({
      registerAddress: vi.fn(async () => ({ handle: "SESSIONID", username: null, lightningAddress: null, sessionLnurl: "LNURL1flagged" }) as never),
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com:8443", client });

    const early = await lnurl.sessionLnurl();

    expect(client.registerAddress).not.toHaveBeenCalled();
    expect((await lnurl.claim({ nameless: true })).lnurl).toBe(early);
  });

  it("syncs nothing once the signal handed to sync has aborted", async () => {
    const store = { upsert: vi.fn(async () => {}), readWatermark: vi.fn(async () => undefined), writeWatermark: vi.fn(async () => {}) };
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client: fakeClient(), store });
    const rx = await lnurl.claim({ username: "alice" });
    const controller = new AbortController();
    controller.abort();

    await expect(rx.sync({ signal: controller.signal })).resolves.toEqual({ synced: 0, failures: [] });
    expect(store.upsert).not.toHaveBeenCalled();
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

  it("forwards a claim code alone, which claims the reserved name it unlocks", async () => {
    const client = fakeClient();
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });

    await lnurl.claim({ claimCode: "code123" });

    expect(client.registerAddress).toHaveBeenCalledWith({
      token: await lnurl.token(), domain: "lnurl.example.com", claimCode: "code123",
    });
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

  it("builds a lnurl on a domain apart from baseUrl, the only host the server answers it on", async () => {
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", domain: "Pay.Example", client: fakeClient() });

    const rx = await lnurl.claim({ username: "alice" });

    expect(rx.lnurl).toBe(encodeLnurl("https://pay.example/.well-known/lnurlp/alice"));
  });

  it("puts a nameless receiver's lnurl and its own payRequest on that domain too", async () => {
    const client = fakeClient({
      registerAddress: vi.fn(async () => ({ handle: "SESSIONID", username: null, lightningAddress: null, sessionLnurl: "LNURL1flagged" }) as never),
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", domain: "pay.example", client });
    const session = encodeLnurl(`https://pay.example/lnurl/${deriveSessionId(await lnurl.token())}`);

    const rx = await lnurl.claim({ nameless: true });
    await rx.payRequest();

    expect(rx.lnurl).toBe(session);
    expect(await lnurl.sessionLnurl()).toBe(session);
    expect(client.resolve).toHaveBeenCalledWith(session);
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

  it("owned({ handle }) picks that active address, and falls back when it is not one", async () => {
    const client = fakeClient({
      listAddresses: vi.fn(async () => [
        { handle: "bob", username: "bob", lightningAddress: "bob@x", status: "active", sessionLnurl: null, domain: "lnurl.example.com" },
        { handle: "old", username: "old", lightningAddress: "old@x", status: "revoked", sessionLnurl: null, domain: "lnurl.example.com" },
        { handle: "SESSIONID", username: null, lightningAddress: null, status: "active", sessionLnurl: "LNURL1flagged", domain: "lnurl.example.com" },
      ]) as never,
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });

    expect((await lnurl.owned({ handle: "bob" }))?.lightningAddress).toBe("bob@x");
    expect((await lnurl.owned({ handle: "old" }))?.handle).toBe("SESSIONID");
    expect((await lnurl.owned({ handle: "gone" }))?.handle).toBe("SESSIONID");
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

  it.each(["a wallet", "an identity and an address"])("claims with %s binding the configured methods", async (source) => {
    const client = fakeClient();
    const holder = source === "a wallet" ? { wallet: fakeWallet() } : { identity: fakeWallet().identity, arkadeAddress: ARKADE_ADDRESS };

    await arkadeLnurl({ ...holder, baseUrl: "https://lnurl.example.com", client, methods: [METHOD] }).claim({ username: "alice" });

    expect(client.registerArkadeIdentity).toHaveBeenCalledWith(expect.objectContaining({ methods: [METHOD] }));
  });

  it("claims without methods unless some are configured, and an empty list counts as configured", async () => {
    const plain = fakeClient();
    await arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client: plain }).claim({ username: "alice" });
    expect(plain.registerArkadeIdentity).toHaveBeenCalledWith(expect.not.objectContaining({ methods: expect.anything() }));

    const emptied = fakeClient();
    await arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client: emptied, methods: [] }).claim({ username: "alice" });
    expect(emptied.registerArkadeIdentity).toHaveBeenCalledWith(expect.objectContaining({ methods: [] }));
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

describe("arkadeLnurl receiver discovery", () => {
  const BASE = "https://lnurl.example.com";
  const CLAIM_KEY = hex.encode(secp256k1.getPublicKey(hex.decode(PRIVATE_KEY), true));
  const row = (handle: string, over: Record<string, unknown> = {}) => ({
    handle, username: handle, lightningAddress: `${handle}@lnurl.example.com`, status: "active",
    sessionLnurl: null, domain: "lnurl.example.com", ...over,
  });
  const boundTo = (arkadeAddress: string | null) =>
    ({ arkadeAddress, claimPublicKey: arkadeAddress && CLAIM_KEY, boardingAddress: arkadeAddress && BOARDING });
  const rebound = (client: LnurlClient) =>
    vi.mocked(client.registerArkadeIdentity).mock.calls.map(([request]) => request.handle);
  const gate = () => {
    let open!: () => void;
    const shut = new Promise<void>((resolve) => (open = resolve));
    return { shut, open };
  };

  it("names its domain and lists every address there, revoked ones included, writing nothing", async () => {
    const client = fakeClient({
      listAddresses: vi.fn(async () => [row("old", { status: "revoked" }), row("foreign", { domain: "other.example" })]) as never,
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: `${BASE}:8443`, client });

    expect(lnurl.domain).toBe("lnurl.example.com");
    expect((await lnurl.addresses()).map((a) => a.handle)).toEqual(["old"]);
    expect(client.registerArkadeIdentity).not.toHaveBeenCalled();
  });

  it("owned() ignores revoked rows, even when they are all there is", async () => {
    const client = fakeClient({ listAddresses: vi.fn(async () => [row("old", { status: "revoked" })]) as never });
    expect(await arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client }).owned()).toBeUndefined();
  });

  it("owned({ refresh }) re-binds only the active aliases whose destination moved", async () => {
    const client = fakeClient({
      listAddresses: vi.fn(async () => [
        row("current", boundTo(ARKADE_ADDRESS)),
        row("moved", boundTo("tark1old")),
        row("unbound", boundTo(null)),
        row("rekeyed", { ...boundTo(ARKADE_ADDRESS), claimPublicKey: "03" + "11".repeat(32) }),
        row("reboarded", { ...boundTo(ARKADE_ADDRESS), boardingAddress: "tb1qold" }),
        row("revoked", { ...boundTo("tark1old"), status: "revoked" }),
        row("foreign", { ...boundTo("tark1old"), domain: "other.example" }),
      ]) as never,
    });

    const rx = await arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client }).owned({ refresh: true });

    expect(rx?.handle).toBe("current");
    expect(rebound(client)).toEqual(["moved", "unbound", "rekeyed", "reboarded"]);
    expect(client.registerArkadeIdentity).toHaveBeenCalledWith(expect.objectContaining({
      arkadeAddress: ARKADE_ADDRESS, claimPublicKey: CLAIM_KEY, boardingAddress: BOARDING, domain: "lnurl.example.com",
    }));
  });

  it("owned({ refresh }) re-binds every active alias on a server that does not report destinations", async () => {
    const client = fakeClient({ listAddresses: vi.fn(async () => [row("alice"), row("bob")]) as never });
    await arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client }).owned({ refresh: true });
    expect(rebound(client)).toEqual(["alice", "bob"]);
  });

  it("owned({ refresh }) leaves a registered boarding address alone when it has none to send", async () => {
    const client = fakeClient({
      listAddresses: vi.fn(async () => [row("kept", boundTo(ARKADE_ADDRESS)), row("moved", boundTo("tark1old"))]) as never,
    });
    const { identity } = fakeWallet();

    await arkadeLnurl({ identity, arkadeAddress: ARKADE_ADDRESS, baseUrl: BASE, client }).owned({ refresh: true });

    expect(rebound(client)).toEqual(["moved"]);
    expect(client.registerArkadeIdentity).toHaveBeenCalledWith(expect.not.objectContaining({ boardingAddress: expect.anything() }));
  });

  const refreshed = async (extra: Record<string, unknown>, methods?: PaymentMethod[]) => {
    const client = fakeClient({ listAddresses: vi.fn(async () => [row("alice", { ...boundTo(ARKADE_ADDRESS), ...extra })]) as never });
    await arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client, ...(methods ? { methods } : {}) }).owned({ refresh: true });
    return client;
  };

  it.each([
    ["methods are added", [], [METHOD]],
    ["a method is added", [METHOD], [METHOD, OTHER]],
    ["a method is dropped", [METHOD, OTHER], [METHOD]],
    ["every method is withdrawn", [METHOD], []],
    ["a method changes type", [{ ...METHOD, type: OTHER.type }], [METHOD]],
    ["a destination changes", [{ ...METHOD, destination: "shrol21xyz" }], [METHOD]],
    ["a duplicate stands in for a method", [METHOD, OTHER], [METHOD, METHOD]],
  ])("owned({ refresh }) re-binds an alias whose registered methods drifted: %s", async (_drift, listed, wanted) => {
    expect(rebound(await refreshed({ paymentMethods: listed }, wanted))).toEqual(["alice"]);
  });

  it("owned({ refresh }) leaves an alias alone when its methods already match", async () => {
    expect(rebound(await refreshed({ paymentMethods: [METHOD] }, [METHOD]))).toEqual([]);
    expect(rebound(await refreshed({ paymentMethods: [] }, []))).toEqual([]);
  });

  it("compares registered methods by type and destination, whatever the order of the list or of a method's keys", async () => {
    expect(rebound(await refreshed({ paymentMethods: [OTHER, METHOD] }, [METHOD, OTHER]))).toEqual([]);
    const reordered = { destination: METHOD.destination, label: "ignored", type: METHOD.type };
    expect(rebound(await refreshed({ paymentMethods: [reordered] }, [METHOD]))).toEqual([]);
  });

  it("owned({ refresh }) never re-binds over the server's methods for a caller that supplies none", async () => {
    expect(rebound(await refreshed({ paymentMethods: [METHOD] }))).toEqual([]);
    expect(rebound(await refreshed({ paymentMethods: [] }))).toEqual([]);
  });

  it.each([
    ["omits the field", {}],
    ["lists null", { paymentMethods: null }],
  ])("owned({ refresh }) re-binds an alias when the server %s and methods are wanted, even an empty list", async (_listing, extra) => {
    expect(rebound(await refreshed(extra, [METHOD]))).toEqual(["alice"]);
    expect(rebound(await refreshed(extra, []))).toEqual(["alice"]);
  });

  it("owned({ refresh }) sends the configured methods on the re-bind", async () => {
    const client = await refreshed({ paymentMethods: [] }, [METHOD, OTHER]);
    expect(client.registerArkadeIdentity).toHaveBeenCalledWith(expect.objectContaining({ handle: "alice", methods: [METHOD, OTHER] }));
  });

  it("owned({ refresh }) re-binds the other aliases when one is refused, then fails closed", async () => {
    const refusal = new LnurlError("Address not found or not owned by this token");
    const client = fakeClient({
      listAddresses: vi.fn(async () => [row("refused", boundTo(null)), row("moved", boundTo("tark1old"))]) as never,
      registerArkadeIdentity: vi.fn(async (request: { handle: string }) => {
        if (request.handle === "refused") throw refusal;
      }) as never,
    });

    await expect(arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client }).owned({ refresh: true })).rejects.toBe(refusal);
    expect(rebound(client)).toEqual(["refused", "moved"]);
  });

  it("owned({ refresh }) binds no further alias once the signal aborts mid-refresh", async () => {
    const controller = new AbortController();
    const client = fakeClient({
      listAddresses: vi.fn(async () => [row("first", boundTo("tark1old")), row("second", boundTo("tark1old"))]) as never,
      registerArkadeIdentity: vi.fn(async () => { controller.abort(); }) as never,
    });

    const owned = arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client }).owned({ signal: controller.signal, refresh: true });

    await expect(owned).rejects.toMatchObject({ name: "AbortError" });
    expect(rebound(client)).toEqual(["first"]);
  });

  it("owned() rejects with the signal's reason and binds nothing once it aborts", async () => {
    const listing = gate();
    const client = fakeClient({
      listAddresses: vi.fn(async () => { await listing.shut; return [row("moved", boundTo("tark1old"))]; }) as never,
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client });
    const controller = new AbortController();

    const owned = lnurl.owned({ signal: controller.signal, refresh: true });
    await vi.waitFor(() => expect(client.listAddresses).toHaveBeenCalled());
    controller.abort();
    listing.open();

    await expect(owned).rejects.toBe(controller.signal.reason);
    expect(client.registerArkadeIdentity).not.toHaveBeenCalled();
    await expect(lnurl.owned({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(client.listAddresses).toHaveBeenCalledOnce();
  });

  it("claim() binds nothing once its signal aborts mid-claim, and registers nothing once aborted", async () => {
    const registering = gate();
    const client = fakeClient({
      registerAddress: vi.fn(async () => {
        await registering.shut;
        return { handle: "alice", username: "alice", lightningAddress: "alice@lnurl.example.com" };
      }) as never,
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client });
    const controller = new AbortController();

    const claiming = lnurl.claim({ username: "alice" }, { signal: controller.signal });
    await vi.waitFor(() => expect(client.registerAddress).toHaveBeenCalled());
    controller.abort();
    registering.open();

    await expect(claiming).rejects.toBe(controller.signal.reason);
    expect(client.registerArkadeIdentity).not.toHaveBeenCalled();
    await expect(lnurl.claim({ username: "bob" }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(client.registerAddress).toHaveBeenCalledOnce();
  });

  it("runs claim, owned and upgrade one at a time per identity and server, across facades and past a failure", async () => {
    const wallet = fakeWallet();
    const client = fakeClient({
      registerAddress: vi.fn(async () => ({ handle: "SESSIONID", username: null, lightningAddress: null, sessionLnurl: "LNURL1flagged" })) as never,
    });
    const nameless = await arkadeLnurl({ wallet, baseUrl: BASE, client }).claim({ nameless: true });
    const binding = gate();
    vi.mocked(client.registerArkadeIdentity).mockImplementationOnce(async () => {
      await binding.shut;
      throw new Error("bind refused");
    });

    const claiming = arkadeLnurl({ wallet, baseUrl: BASE, client }).claim({ nameless: true });
    const discovering = arkadeLnurl({ wallet, baseUrl: BASE, client }).owned();
    const upgrading = nameless.upgrade({ username: "alice" });
    await vi.waitFor(() => expect(client.registerArkadeIdentity).toHaveBeenCalledTimes(2));
    expect(client.listAddresses).not.toHaveBeenCalled();
    expect(client.upgradeAddress).not.toHaveBeenCalled();

    binding.open();
    await expect(claiming).rejects.toMatchObject({ message: "bind refused" });
    await discovering;
    await upgrading;
    expect(client.listAddresses).toHaveBeenCalledOnce();
    expect(client.upgradeAddress).toHaveBeenCalledOnce();
  });
});

describe("Receiver.payRequest()", () => {
  const BASE = "https://lnurl.example.com";
  // Echoes the LNURL it was asked for, so a memo serving the wrong receiver shows in the value.
  const echoing = (over: Partial<LnurlClient> = {}) =>
    fakeClient({ resolve: vi.fn(async (lnurl: string) => ({ tag: "payRequest", lnurl }) as never), ...over });
  const claimed = (client: LnurlClient) => arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client }).claim({ username: "alice" });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches once for two calls within the TTL", async () => {
    const client = echoing();
    const rx = await claimed(client);

    await rx.payRequest();
    await rx.payRequest();

    expect(client.resolve).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight fetch between concurrent calls", async () => {
    const client = echoing();
    const rx = await claimed(client);

    const [a, b] = await Promise.all([rx.payRequest(), rx.payRequest()]);

    expect(a).toBe(b);
    expect(client.resolve).toHaveBeenCalledTimes(1);
  });

  it("fetches again once the TTL has passed", async () => {
    vi.useFakeTimers();
    const client = echoing();
    const rx = await claimed(client);

    await rx.payRequest();
    vi.advanceTimersByTime(PAY_REQUEST_TTL_MS - 1);
    await rx.payRequest();
    expect(client.resolve).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await rx.payRequest();
    expect(client.resolve).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed fetch", async () => {
    const client = echoing({
      resolve: vi.fn().mockRejectedValueOnce(new LnurlError("down")).mockResolvedValue({ tag: "payRequest" }),
    });
    const rx = await claimed(client);

    await expect(rx.payRequest()).rejects.toThrow("down");
    await expect(rx.payRequest()).resolves.toMatchObject({ tag: "payRequest" });

    expect(client.resolve).toHaveBeenCalledTimes(2);
  });

  it("fetches again after upgrade(), even one that failed", async () => {
    const client = echoing({
      registerAddress: vi.fn(async () => ({ handle: "SESSIONID", username: null, lightningAddress: null, sessionLnurl: "LNURL1flagged" }) as never),
      upgradeAddress: vi.fn()
        .mockRejectedValueOnce(new LnurlError("taken"))
        .mockResolvedValue({ handle: "alice", username: "alice", lightningAddress: "alice@lnurl.example.com" }),
    });
    const rx = await arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client }).claim({ nameless: true });

    await rx.payRequest();
    await expect(rx.upgrade({ username: "alice" })).rejects.toThrow("taken");
    await rx.payRequest();
    await rx.upgrade({ username: "alice" });
    await rx.payRequest();

    expect(client.resolve).toHaveBeenCalledTimes(3);
  });

  it("fetches again after claim(), for a receiver it made earlier", async () => {
    const client = echoing({
      listAddresses: vi.fn(async () => [
        { handle: "alice", username: "alice", lightningAddress: "alice@x", status: "active", sessionLnurl: null, domain: "lnurl.example.com" },
      ]) as never,
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client });
    const rx = (await lnurl.owned())!;

    await rx.payRequest();
    await lnurl.claim({ username: "alice" });
    await rx.payRequest();

    expect(client.resolve).toHaveBeenCalledTimes(2);
  });

  it("keeps one memo per Receiver", async () => {
    const client = echoing({
      registerAddress: vi.fn(async (req: { username?: string }) =>
        ({ handle: req.username, username: req.username, lightningAddress: `${req.username}@lnurl.example.com` }) as never),
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: BASE, client });
    const alice = await lnurl.claim({ username: "alice" });
    const bob = await lnurl.claim({ username: "bob" });

    expect(await alice.payRequest()).toMatchObject({ lnurl: alice.lnurl });
    expect(await bob.payRequest()).toMatchObject({ lnurl: bob.lnurl });
    await alice.payRequest();

    expect(client.resolve).toHaveBeenCalledTimes(2);
  });
});

describe("arkadePaymentRouter", () => {
  const UNIFIED = "bitcoin:tb1pgk4xl52hczpgz0fp429ccvdztvmhd5mthd7xxj8aq4nvstc7kzcql3fvdu"
    + "?ark=tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf858t79qp09kwef5q27wqrep4teavv3j6fk2wpdd3674z306qy00sr5h9h6y"
    + "&lightning=lntbs60020n1p4vt7d3pp5n7hcxe4650eatxe3ap4eqzjt8am6ldzzs0lzhm63yy6rfklptl8sdqqcqzpkxqrpc8sp5hrhtzvzwqq3qxcfuushmeqh0kw05ym3alhm3l73aeufcea42hh3q9qxpqysgqgks7jz3nm8l5lz4v9y7cwc682nza8j8j3q6k4ez6qg077utxy0hnh3k3gy3ek7ejn4kf55ljrwh2ytr2xvyx2y7aqldjclkjh5qklegqxtquau"
    + "&amount=0.00005936";

  const invoiceOnly = (): PaymentRail & { quoted: (number | undefined)[] } => {
    const quoted: (number | undefined)[] = [];
    return {
      id: "solver-lightning",
      quoted,
      match: (req) => invoiceTarget(req.raw) !== undefined,
      available: (req) => req.amount === undefined || req.amount === 6002,
      quote: async (req) => { quoted.push(req.amount); return { railId: "solver-lightning" } as unknown as RouteQuote; },
    };
  };

  it("offers a unified URI's lightning leg when the amount restates the URI's own", async () => {
    const lightning = invoiceOnly();
    const router = arkadePaymentRouter({ wallet: fakeWallet(), lightning });

    const options = await router.options({ raw: UNIFIED, amount: 5936 }, { priority: DEFAULT_RAIL_PRIORITY });
    await options.find((o) => o.railId === "solver-lightning")?.quote();

    expect(options.map((o) => o.railId)).toEqual(["ark", "solver-lightning", "onchain"]);
    expect(lightning.quoted).toEqual([undefined]);
  });

  it("still drops the lightning leg for an amount the URI does not name", async () => {
    const router = arkadePaymentRouter({ wallet: fakeWallet(), lightning: invoiceOnly() });

    const options = await router.options({ raw: UNIFIED, amount: 7000 }, { priority: DEFAULT_RAIL_PRIORITY });

    expect(options.map((o) => o.railId)).toEqual(["ark", "onchain"]);
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
