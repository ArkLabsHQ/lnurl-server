import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import type { Response } from "express";
import { SessionManager } from "../src/session-manager.js";

describe("SessionManager.activeSessionIds", () => {
  it("lists live session ids", () => {
    const sm = new SessionManager();
    const s = sm.create(new PassThrough() as unknown as Response, "ab".repeat(32))!;
    expect(sm.activeSessionIds()).toContain(s.id);
  });
});
