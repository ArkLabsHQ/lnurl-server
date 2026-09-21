import { describe, it, expect, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import type { Wallet } from "@arkade-os/sdk";
import { arkadeLnurl, encodeLnurl } from "../src/wallet.js";
import type { LnurlClient } from "../src/index.js";
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
  registerAddress: vi.fn(async () => ({ username: "alice", lightningAddress: "alice@example.com" }) as never),
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

    const result = await lnurl.claim("Alice");

    expect(result).toEqual({ username: "alice", lightningAddress: "alice@example.com" });
    expect(client.registerAddress).toHaveBeenCalledWith({ token: await lnurl.token(), username: "Alice" });
    // The bind is the half that makes offline receive exist; the boarding
    // address rides along so the onchain rail is advertised from the first
    // payRequest rather than needing a second call.
    expect(client.registerArkadeIdentity).toHaveBeenCalledWith(expect.objectContaining({
      username: "alice",
      arkadeAddress: ARKADE_ADDRESS,
      boardingAddress: BOARDING,
      claimPublicKey: hex.encode(secp256k1.getPublicKey(hex.decode(PRIVATE_KEY), true)),
    }));
  });

  // A LUD-16 domain cannot carry a port, and the server files the address under
  // the bare host — so a dev server on :4283 must still resolve.
  it("files the address under the bare hostname, not the host with its port", async () => {
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "http://127.0.0.1:4283", client: fakeClient() });
    expect(lnurl.lightningAddress("Alice")).toBe("alice@127.0.0.1");
  });

  it("addresses its own payRequest through baseUrl, which keeps the port", async () => {
    const client = fakeClient();
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "http://127.0.0.1:4283", client });

    await lnurl.payRequest("Alice");

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
        { username: "old", status: "revoked" },
        { username: "current", status: "active" },
      ]) as never,
    });
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });
    expect(await lnurl.owned()).toBe("current");
  });

  it("says what is missing when sync has nowhere to write", async () => {
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client: fakeClient() });
    await expect(lnurl.sync("alice")).rejects.toThrow(LnurlError);
  });

  it("scopes a payments query to its own domain", async () => {
    const client = fakeClient();
    const lnurl = arkadeLnurl({ wallet: fakeWallet(), baseUrl: "https://lnurl.example.com", client });

    await lnurl.payments("alice", { limit: 10 });

    expect(client.listPayments).toHaveBeenCalledWith(
      await lnurl.token(), "alice", { domain: "lnurl.example.com", limit: 10 },
    );
  });
});
