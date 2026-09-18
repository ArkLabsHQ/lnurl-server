import { describe, it, expect, vi } from "vitest";
import { pollVerify } from "../src/payer.js";
import { LnurlError, LnurlTimeoutError } from "../src/errors.js";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("pollVerify", () => {
  it("resolves once settled and reports each update", async () => {
    const bodies = [
      { status: "OK", settled: false, preimage: null, pr: "lnbc1..." },
      { status: "OK", settled: true, preimage: "ab".repeat(32), pr: "lnbc1..." },
    ];
    let i = 0;
    const fetchImpl = async () => jsonResponse(bodies[Math.min(i++, bodies.length - 1)]);
    const updates: unknown[] = [];
    const r = await pollVerify("https://x/v/h", { intervalMs: 1, onUpdate: (s) => updates.push(s) }, fetchImpl as never);
    expect(r).toMatchObject({ kind: "bolt11", settled: true, preimage: "ab".repeat(32) });
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });

  it("treats a Not found ERROR body as terminal", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "ERROR", reason: "Not found" }));
    await expect(pollVerify("https://x/v/h", { intervalMs: 1 }, fetchImpl as never)).rejects.toBeInstanceOf(LnurlError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("parses the destination shape", async () => {
    const fetchImpl = async () => jsonResponse({ status: "OK", settled: true, paymentOption: "arkade", paymentDestination: "ark1xyz", paymentReference: "txid123" });
    const r = await pollVerify("https://x/v/id", { intervalMs: 1 }, fetchImpl as never);
    expect(r).toEqual({ kind: "destination", settled: true, paymentOption: "arkade", paymentDestination: "ark1xyz", paymentReference: "txid123" });
  });

  it("times out with the last snapshot attached", async () => {
    const fetchImpl = async () => jsonResponse({ status: "OK", settled: false, preimage: null, pr: "lnbc1..." });
    const err = await pollVerify("https://x/v/h", { intervalMs: 1, timeoutMs: 15 }, fetchImpl as never).catch((e) => e);
    expect(err).toBeInstanceOf(LnurlTimeoutError);
    expect(err.lastSnapshot).toMatchObject({ settled: false });
  });

  it("rejects an empty verify URL instead of polling undefined", async () => {
    const fetchImpl = async () => { throw new Error("must not be called"); };
    await expect(pollVerify("", { intervalMs: 1 }, fetchImpl as never)).rejects.toBeInstanceOf(LnurlError);
  });
});
