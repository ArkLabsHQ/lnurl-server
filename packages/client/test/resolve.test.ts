import { describe, it, expect } from "vitest";
import { resolve } from "../src/payer.js";
import { LnurlError } from "../src/errors.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const payRequestBody = {
  tag: "payRequest",
  callback: "https://arkadeos.com/.well-known/lnurlp/alice/callback",
  minSendable: 1000,
  maxSendable: 100000000,
  metadata: "[[\"text/plain\",\"pay alice\"]]",
  commentAllowed: 140,
  paymentOptions: [{ id: "lightning", type: "lightning" }, { id: "arkade", type: "arkade" }],
};

describe("resolve", () => {
  it("fetches the address payRequest and tags the surface", async () => {
    let seen = "";
    const fetchImpl = async (url: string) => { seen = String(url); return jsonResponse(payRequestBody); };
    const pr = await resolve("alice@arkadeos.com", fetchImpl as never);
    expect(seen).toBe("https://arkadeos.com/.well-known/lnurlp/alice");
    expect(pr.source.surface).toBe("address");
    expect(pr.paymentOptions).toHaveLength(2);
  });

  it("rejects a response that is not a payRequest", async () => {
    const fetchImpl = async () => jsonResponse({ tag: "withdrawRequest" });
    await expect(resolve("alice@arkadeos.com", fetchImpl as never)).rejects.toBeInstanceOf(LnurlError);
  });

  it("propagates a server ERROR body", async () => {
    const fetchImpl = async () => jsonResponse({ status: "ERROR", reason: "Unknown LN address" });
    await expect(resolve("ghost@arkadeos.com", fetchImpl as never)).rejects.toThrow("Unknown LN address");
  });
});
