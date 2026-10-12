import { describe, it, expect, vi } from "vitest";
import { batchVerify, openVerifyBatchStream } from "../src/verify-batch.js";
import { INVOICE, PREIMAGE } from "./invoice.js";

const BATCH = "https://x/lnurl/verifyBatch";
const V = "https://x/lnurl/verify/" + "ab".repeat(32);
const snapshot = (results: Record<string, unknown>) =>
  new Response(JSON.stringify({ status: "OK", results }), { status: 200, headers: { "content-type": "application/json" } });

describe("openVerifyBatchStream", () => {
  it("retries without the event-stream Accept on 406 and delivers the snapshot", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      (init?.headers as Record<string, string> | undefined)?.Accept === "text/event-stream"
        ? new Response("", { status: 406, statusText: "Not Acceptable" })
        : snapshot({ [V]: { status: "OK", settled: false, preimage: null, pr: "lnbc1" } }),
    );
    const updates: string[] = [];
    const errors: unknown[] = [];
    await new Promise<void>((resolve) => {
      openVerifyBatchStream(
        { verifyBatchUrl: BATCH, verifyUrls: [V] },
        { onUpdate: (url) => updates.push(url), onError: (e) => errors.push(e), onClose: resolve },
        fetchImpl as never,
      );
    });
    expect(errors).toEqual([]);
    expect(updates).toEqual([V]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![0]).toBe(`${BATCH}?verify=${encodeURIComponent(V)}`);
  });
});

describe("batchVerify", () => {
  it("turns a settled result with the wrong preimage into an error item, keeping the rest", async () => {
    const other = "https://x/lnurl/verify/" + "cd".repeat(32);
    const fetchImpl = vi.fn(async () => snapshot({
      [V]: { status: "OK", settled: true, preimage: "cd".repeat(32), pr: INVOICE },
      [other]: { status: "OK", settled: true, preimage: PREIMAGE, pr: INVOICE },
    }));
    const { results } = await batchVerify(BATCH, [V, other], undefined, fetchImpl as never);
    expect(results[V]).toEqual({ kind: "error", reason: expect.stringMatching(/preimage/) });
    expect(results[other]).toMatchObject({ kind: "verify", status: { settled: true, preimage: PREIMAGE } });
  });

  it.each([414, 431])("splits the set and merges the answers on %i", async (tooBig) => {
    const urls = ["a", "b", "c", "d", "e"].map((k) => `https://x/lnurl/verify/${k}`);
    const fetchImpl = vi.fn(async (url: string) => {
      const asked = new URL(url).searchParams.getAll("verify");
      if (asked.length > 2) return new Response("", { status: tooBig });
      return snapshot(Object.fromEntries(asked.map((u) => [u, { status: "ERROR", reason: "unknown verify url" }])));
    });
    const { results } = await batchVerify(BATCH, urls, undefined, fetchImpl as never);
    expect(Object.keys(results).sort()).toEqual(urls);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not split a single URL that is still too large", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 414 }));
    await expect(batchVerify(BATCH, [V], undefined, fetchImpl as never)).rejects.toMatchObject({ httpStatus: 414 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a __proto__ key and ignores inherited ones", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"status":"OK","results":{"__proto__":{"status":"ERROR","reason":"unknown verify url"}}}', { status: 200 }),
    );
    const { results } = await batchVerify(BATCH, ["__proto__", "toString"], undefined, fetchImpl as never);
    expect(Object.keys(results).sort()).toEqual(["__proto__", "toString"]);
    expect(results["__proto__"]).toEqual({ kind: "error", reason: "unknown verify url" });
    expect(results["toString"]).toEqual({ kind: "error", reason: "no answer for this verify url" });
  });
});
