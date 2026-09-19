import { describe, it, expect } from "vitest";
import {
  assertCovenantSupplyAccepted,
  fetchCovenantRecovery,
  fetchSwapRecovery,
  listAddresses,
  listPayments,
  registerAddress,
  registerArkadeIdentity,
  revokeAddress,
} from "../src/addresses.js";
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

  it("sends boardingAddress when one is given", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = async (_u: string, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return json({ ok: true }); };
    await registerArkadeIdentity("https://x", {
      token: "tok", username: "alice", arkadeAddress: "ark1qqq", claimPublicKey: "02" + "ab".repeat(32),
      boardingAddress: "bcrt1qboarding",
    }, fetchImpl as never);
    expect(body.boardingAddress).toBe("bcrt1qboarding");
  });

  // Absent leaves a registered rail alone server-side; an empty value does not.
  it("omits boardingAddress entirely when none is given", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = async (_u: string, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return json({ ok: true }); };
    await registerArkadeIdentity("https://x", {
      token: "tok", username: "alice", arkadeAddress: "ark1qqq", claimPublicKey: "02" + "ab".repeat(32),
    }, fetchImpl as never);
    expect("boardingAddress" in body).toBe(false);
  });
});

describe("registerArkadeIdentity covenant supply", () => {
  const base = { token: "tok", username: "alice", arkadeAddress: "ark1qqq", claimPublicKey: "02" + "ab".repeat(32) };
  const profile = { recoveryDelaySeconds: 86_528, emulatorPubkey: "ab".repeat(32) };
  const supply = { scheme: "salted-v1", startIndex: 0, preimages: ["cd".repeat(32), "ef".repeat(32)], profile };
  const ack = { accepted: true as const, nextIndex: 2, remaining: 2, scheme: "salted-v1", profile };

  it("sends the supply and returns the acknowledgement", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = async (_u: string, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return json({ ok: true, covenantSupply: ack }); };
    const res = await registerArkadeIdentity("https://x", { ...base, covenantSupply: supply }, fetchImpl as never);
    expect(body.covenantSupply).toEqual(supply);
    expect(res.covenantSupply).toEqual(ack);
  });

  it("omits both supplies entirely when neither is given", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = async (_u: string, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return json({ ok: true }); };
    const res = await registerArkadeIdentity("https://x", base, fetchImpl as never);
    expect("covenantSupply" in body).toBe(false);
    expect("swapSupply" in body).toBe(false);
    expect(res).toEqual({});
  });

  it("keeps the two legs as separate fields on the wire", async () => {
    let body: Record<string, unknown> = {};
    const swap = { scheme: "salted-v1", startIndex: 0, preimages: ["11".repeat(32)] };
    const fetchImpl = async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return json({ ok: true, covenantSupply: ack, swapSupply: { accepted: true, nextIndex: 1, remaining: 1, scheme: "salted-v1" } });
    };
    const res = await registerArkadeIdentity("https://x", { ...base, covenantSupply: supply, swapSupply: swap }, fetchImpl as never);
    expect(body.swapSupply).toEqual(swap);
    expect(body.covenantSupply).not.toEqual(body.swapSupply);
    expect(res.swapSupply?.nextIndex).toBe(1);
  });

  // The dangerous compatibility direction: a server older than the protocol
  // parses the body field by field, drops what it does not know, and answers
  // {ok:true}. Silent success there is a wallet believing its destinations are
  // recoverable when they are not.
  it("reports NOT accepted when an old server answers {ok:true} with no echo", async () => {
    const fetchImpl = async () => json({ ok: true });
    const res = await registerArkadeIdentity("https://x", { ...base, covenantSupply: supply }, fetchImpl as never);
    expect(res.covenantSupply).toBeUndefined();
    expect(() => assertCovenantSupplyAccepted(res, supply)).toThrow(/did not acknowledge/);
  });

  it("refuses an echo that does not cover the batch that was sent", async () => {
    const short = async () => json({ ok: true, covenantSupply: { ...ack, nextIndex: 1 } });
    const wrongScheme = async () => json({ ok: true, covenantSupply: { ...ack, scheme: "hd-v9" } });
    await expect(registerArkadeIdentity("https://x", { ...base, covenantSupply: supply }, short as never)
      .then((r) => assertCovenantSupplyAccepted(r, supply))).rejects.toThrow(/nextIndex 1/);
    await expect(registerArkadeIdentity("https://x", { ...base, covenantSupply: supply }, wrongScheme as never)
      .then((r) => assertCovenantSupplyAccepted(r, supply))).rejects.toThrow(/scheme "hd-v9"/);
  });

  it("accepts an echo that matches", async () => {
    const fetchImpl = async () => json({ ok: true, covenantSupply: ack });
    const res = await registerArkadeIdentity("https://x", { ...base, covenantSupply: supply }, fetchImpl as never);
    expect(assertCovenantSupplyAccepted(res, supply)).toEqual(ack);
  });
});

describe("recovery reads", () => {
  it("fetches covenant destinations with the bearer token", async () => {
    let seen = "";
    let headers: Record<string, string> = {};
    const body = { scheme: "salted-v1", profile: null, destinations: [{ verifyId: "v1", address: "tark1", covenantScript: "51", covenantIndex: 0, params: { preimage: "aa" }, createdAt: 1 }] };
    const fetchImpl = async (url: string, init?: RequestInit) => { seen = String(url); headers = init?.headers as Record<string, string>; return json(body); };
    const r = await fetchCovenantRecovery("https://x", "tok", "alice", { domain: "d.example" }, fetchImpl as never);
    expect(seen).toBe("https://x/lnurl/address/alice/covenant-recovery?domain=d.example");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(r.destinations[0]!.params).toEqual({ preimage: "aa" });
  });

  it("unwraps the swap recovery page", async () => {
    let seen = "";
    const swaps = [{ paymentHash: "aa", preimage: "bb", swapIndex: 3, settled: false, createdAt: 1, recovery: { version: 1 } }];
    const fetchImpl = async (url: string) => { seen = String(url); return json({ swaps }); };
    const r = await fetchSwapRecovery("https://x", "tok", "alice", undefined, fetchImpl as never);
    expect(seen).toBe("https://x/lnurl/address/alice/swap-recovery");
    expect(r).toEqual(swaps);
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
