import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import type { Response } from "express";
import { SessionManager } from "../src/session-manager.js";

const res = () => new PassThrough() as unknown as Response;

describe("SessionManager.listSessions / disconnect", () => {
  it("flags reusable (token) vs ephemeral (random) sessions and records the client ip", () => {
    const sm = new SessionManager();
    const reusable = sm.create(res(), "ab".repeat(32), "10.0.0.1")!;
    const ephemeral = sm.create(res(), undefined, "10.0.0.2")!;
    const byId = Object.fromEntries(sm.listSessions().map((s) => [s.id, s]));
    expect(byId[reusable.id]).toMatchObject({ reusable: true, ip: "10.0.0.1", invoicesIssued: 0, pending: null });
    expect(byId[ephemeral.id]).toMatchObject({ reusable: false, ip: "10.0.0.2" });
  });

  it("never exposes the token or socket in the listing", () => {
    const sm = new SessionManager();
    sm.create(res(), "cd".repeat(32));
    const info = sm.listSessions()[0] as Record<string, unknown>;
    expect(info).not.toHaveProperty("token");
    expect(info).not.toHaveProperty("sseRes");
  });

  it("surfaces the pending request and counts issued invoices", async () => {
    const sm = new SessionManager();
    const s = sm.create(res(), undefined, "1.2.3.4")!;
    const p = sm.requestInvoice(s.id, 21000, "thanks", 5000);
    const pending = sm.listSessions()[0].pending;
    expect(pending).toMatchObject({ amountMsat: 21000, comment: "thanks" });
    expect(typeof pending!.since).toBe("number");

    sm.resolveInvoice(s.id, "lnbc1pretend");
    await expect(p).resolves.toBe("lnbc1pretend");
    const info = sm.listSessions()[0];
    expect(info.invoicesIssued).toBe(1);
    expect(info.pending).toBeNull();
    expect(typeof info.lastInvoiceAt).toBe("number");
  });

  it("disconnect ends the stream, drops the session, and is idempotent", () => {
    const sm = new SessionManager();
    const stream = new PassThrough();
    const s = sm.create(stream as unknown as Response, "ef".repeat(32))!;
    expect(sm.disconnect(s.id)).toBe(true);
    expect(sm.isActive(s.id)).toBe(false);
    expect(sm.listSessions()).toHaveLength(0);
    expect(stream.writableEnded).toBe(true);
    expect(sm.disconnect(s.id)).toBe(false);
  });
});
