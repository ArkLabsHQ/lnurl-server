import { describe, it, expect } from "vitest";
import { registerAddress, listAddresses, listPayments, revokeAddress, registerArkadeIdentity } from "../src/addresses.js";
import { LnurlError } from "../src/errors.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("registerAddress", () => {
  it("posts the token and returns the 201 body", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen = { url: String(url), init };
      return json({ lightningAddress: "alice@arkadeos.com", lnurl: "LNURL1", username: "alice", domain: "arkadeos.com", status: "active" }, 201);
    };
    const r = await registerAddress("https://x", { token: "tok", username: "alice" }, fetchImpl as never);
    expect(seen!.url).toBe("https://x/lnurl/address");
    expect(JSON.parse(String(seen!.init?.body))).toEqual({ token: "tok", username: "alice" });
    expect(r.lightningAddress).toBe("alice@arkadeos.com");
  });

  it("sends X-API-Key when supplied", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = async (_u: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return json({ lightningAddress: "a@b", lnurl: "L", username: "a", domain: "b", status: "active" }, 201);
    };
    await registerAddress("https://x", { token: "tok", apiKey: "k1" }, fetchImpl as never);
    expect(headers["X-API-Key"]).toBe("k1");
  });

  it("surfaces a provisioning code", async () => {
    const fetchImpl = async () => json({ error: "Username taken", code: "USERNAME_TAKEN" }, 409);
    await expect(registerAddress("https://x", { token: "tok", username: "alice" }, fetchImpl as never))
      .rejects.toMatchObject({ code: "USERNAME_TAKEN", httpStatus: 409 });
  });
});

describe("listAddresses / revokeAddress", () => {
  it("lists with a bearer token", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = async (_u: string, init?: RequestInit) => { headers = init?.headers as Record<string, string>; return json([]); };
    await listAddresses("https://x", "tok", fetchImpl as never);
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("revokes with the domain query when given", async () => {
    let seen = "";
    const fetchImpl = async (url: string) => { seen = String(url); return json({ ok: true }); };
    await revokeAddress("https://x", "tok", "alice", { domain: "arkadeos.com" }, fetchImpl as never);
    expect(seen).toBe("https://x/lnurl/address/alice?domain=arkadeos.com");
  });
});

describe("registerArkadeIdentity", () => {
  it("posts to the per-username arkade route", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = async (url: string, init?: RequestInit) => { seen = { url: String(url), init }; return json({ ok: true }); };
    await registerArkadeIdentity("https://x", {
      token: "tok", username: "alice", arkadeAddress: "ark1qqq", claimPublicKey: "02" + "ab".repeat(32),
    }, fetchImpl as never);
    expect(seen!.url).toBe("https://x/lnurl/address/alice/arkade");
    expect((seen!.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(seen!.init?.body))).toMatchObject({ arkadeAddress: "ark1qqq" });
  });

  it("rejects an uncompressed claim public key before the network", async () => {
    const fetchImpl = async () => { throw new Error("must not be called"); };
    await expect(registerArkadeIdentity("https://x", {
      token: "tok", username: "alice", arkadeAddress: "ark1qqq", claimPublicKey: "04" + "ab".repeat(32),
    }, fetchImpl as never)).rejects.toBeInstanceOf(LnurlError);
  });
});
describe("listPayments", () => {
  const bolt11Row = {
    paymentHash: "aa".repeat(32),
    pr: "lnbc1",
    preimage: null,
    swapId: null,
    paymentOption: "lightning",
    paymentDestination: null,
    covenantScript: null,
    paymentReference: null,
    settled: false,
    amountMsat: 1000,
    createdAt: 1000,
    settledAt: null,
  };
  const arkadeRow = {
    paymentHash: "verify-1",
    pr: "",
    preimage: null,
    swapId: null,
    paymentOption: "arkade",
    paymentDestination: "ark1qqq",
    covenantScript: "0014abcd",
    paymentReference: null,
    settled: false,
    amountMsat: 2000,
    createdAt: 2000,
    settledAt: null,
  };
  const pageBody = {
    source: { domain: "arkadeos.com", lightningAddress: "alice@arkadeos.com" },
    payments: [bolt11Row, arkadeRow],
    nextSince: 2000,
  };

  it("sends domain, since and limit as query params with a bearer token", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen = { url: String(url), init };
      return json(pageBody);
    };
    await listPayments("https://x", "tok", "alice", { domain: "arkadeos.com", since: 123, limit: 10 }, fetchImpl as never);
    expect(seen!.url).toBe("https://x/lnurl/address/alice/payments?domain=arkadeos.com&since=123&limit=10");
    expect((seen!.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("maps a lightning record to kind bolt11 with paymentHash set", async () => {
    const fetchImpl = async () => json(pageBody);
    const page = await listPayments("https://x", "tok", "alice", undefined, fetchImpl as never);
    expect(page.payments[0]).toEqual({
      kind: "bolt11",
      paymentHash: bolt11Row.paymentHash,
      pr: "lnbc1",
      preimage: null,
      swapId: null,
      settled: false,
      amountMsat: 1000,
      createdAt: 1000,
      settledAt: null,
    });
  });

  it("maps an arkade record to kind destination with verifyId and no paymentHash", async () => {
    const fetchImpl = async () => json(pageBody);
    const page = await listPayments("https://x", "tok", "alice", undefined, fetchImpl as never);
    const got = page.payments[1];
    expect(got).toEqual({
      kind: "destination",
      verifyId: "verify-1",
      paymentOption: "arkade",
      paymentDestination: "ark1qqq",
      covenantScript: "0014abcd",
      paymentReference: null,
      settled: false,
      amountMsat: 2000,
      createdAt: 2000,
      settledAt: null,
    });
    expect("paymentHash" in got).toBe(false);
  });

  it("passes source and nextSince through unchanged", async () => {
    const fetchImpl = async () => json(pageBody);
    const page = await listPayments("https://x", "tok", "alice", undefined, fetchImpl as never);
    expect(page.source).toEqual({ domain: "arkadeos.com", lightningAddress: "alice@arkadeos.com" });
    expect(page.nextSince).toBe(2000);
  });
});
