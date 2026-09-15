import { describe, it, expect } from "vitest";
import { lnurlFetch, apiFetch } from "../src/http.js";
import { LnurlError, LnurlTransportError } from "../src/errors.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("lnurlFetch", () => {
  it("returns the body on success", async () => {
    const fetchImpl = async () => jsonResponse({ tag: "payRequest", minSendable: 1000 });
    await expect(lnurlFetch<{ tag: string }>("https://x/y", undefined, fetchImpl as never))
      .resolves.toMatchObject({ tag: "payRequest" });
  });

  it("throws LnurlError on a 200 carrying status ERROR", async () => {
    const fetchImpl = async () => jsonResponse({ status: "ERROR", reason: "This LNURL is no longer active" });
    await expect(lnurlFetch("https://x/y", undefined, fetchImpl as never))
      .rejects.toThrow(new LnurlError("This LNURL is no longer active"));
  });

  it("marks a 429 retryable", async () => {
    const fetchImpl = async () => jsonResponse({ status: "ERROR", reason: "Too many requests" }, 429);
    await expect(lnurlFetch("https://x/y", undefined, fetchImpl as never))
      .rejects.toMatchObject({ retryable: true, httpStatus: 429 });
  });

  it("wraps a transport failure", async () => {
    const boom = new TypeError("network down");
    const fetchImpl = async () => { throw boom; };
    await expect(lnurlFetch("https://x/y", undefined, fetchImpl as never))
      .rejects.toBeInstanceOf(LnurlTransportError);
  });
});

describe("apiFetch", () => {
  it("throws LnurlError with status and code on a non-2xx", async () => {
    const fetchImpl = async () => jsonResponse({ error: "Unauthorized" }, 401);
    await expect(apiFetch("https://x/y", undefined, fetchImpl as never))
      .rejects.toMatchObject({ reason: "Unauthorized", httpStatus: 401, retryable: false });
  });

  it("surfaces a provisioning code when present", async () => {
    const fetchImpl = async () => jsonResponse({ error: "Username taken", code: "USERNAME_TAKEN" }, 409);
    await expect(apiFetch("https://x/y", undefined, fetchImpl as never))
      .rejects.toMatchObject({ code: "USERNAME_TAKEN", httpStatus: 409 });
  });

  it("returns the body on 201", async () => {
    const fetchImpl = async () => jsonResponse({ ok: true }, 201);
    await expect(apiFetch<{ ok: boolean }>("https://x/y", undefined, fetchImpl as never))
      .resolves.toEqual({ ok: true });
  });
});