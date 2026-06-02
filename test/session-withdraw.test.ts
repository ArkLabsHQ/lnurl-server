import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import type { Response } from "express";
import { SessionManager } from "../src/session-manager.js";

// Minimal fake SSE Response that records written chunks.
function fakeRes() {
  const stream = new PassThrough();
  let buf = "";
  stream.on("data", (c) => (buf += c.toString()));
  const res = Object.assign(stream, { write: (c: string) => { buf += c; return true; } }) as unknown as Response;
  return { res, read: () => buf };
}

describe("SessionManager withdraw", () => {
  it("emits withdraw_request and resolves when confirmed", async () => {
    const sm = new SessionManager();
    const { res, read } = fakeRes();
    const session = sm.create(res, "ab".repeat(32))!;
    const p = sm.requestWithdraw(session.id, { withdrawId: "w1", bolt11: "lnbc1", minWithdrawable: 1, maxWithdrawable: 9 }, 2000);
    expect(read()).toContain("withdraw_request");
    expect(sm.resolveWithdraw(session.id, "w1")).toBe(true);
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects a confirm whose withdrawId does not match", async () => {
    const sm = new SessionManager();
    const { res } = fakeRes();
    const session = sm.create(res, "cd".repeat(32))!;
    const p = sm.requestWithdraw(session.id, { withdrawId: "w1", bolt11: "x", minWithdrawable: 1, maxWithdrawable: 9 }, 2000);
    expect(sm.resolveWithdraw(session.id, "other")).toBe(false);
    expect(sm.rejectWithdraw(session.id, "w1", "declined")).toBe(true);
    await expect(p).rejects.toThrow(/declined/);
  });
});

describe("SessionManager auth", () => {
  it("verifyToken is constant-time-safe: false for wrong/short tokens, no throw", () => {
    const sm = new SessionManager();
    const { res } = fakeRes();
    const token = "ab".repeat(32);
    const session = sm.create(res, token)!;
    expect(sm.verifyToken(session.id, token)).toBe(true);
    expect(sm.verifyToken(session.id, "short")).toBe(false); // different length
    expect(sm.verifyToken(session.id, "ab".repeat(31))).toBe(false);
    expect(sm.verifyToken(session.id, "cd".repeat(32))).toBe(false); // same length, wrong value
  });

  it("peekCollision is false for a fresh token", () => {
    const sm = new SessionManager();
    expect(sm.peekCollision("ab".repeat(32))).toBe(false);
  });
});
