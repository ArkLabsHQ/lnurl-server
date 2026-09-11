import { describe, expect, it, vi } from "vitest";
import { HealthRegistry } from "../src/health.js";
import { createRuntime } from "../src/runtime.js";
import { createLogger } from "../src/logger.js";

describe("runtime shutdown", () => {
  it("marks unready before closing every owned resource and is idempotent", async () => {
    const order: string[] = [];
    const health = new HealthRegistry();
    const runtime = createRuntime(health);
    runtime.addStop(() => { order.push(`stop:${health.ready()}`); });
    runtime.addTransport({ close: async () => { order.push("transport"); } });
    runtime.setDatabase({ close: vi.fn(() => { order.push("db"); }) });

    const first = runtime.shutdown("SIGTERM");
    expect(health.ready()).toBe(false);
    await Promise.all([first, runtime.shutdown("SIGTERM")]);
    expect(order).toEqual(["stop:false", "transport", "db"]);
    expect(runtime.resources()).toEqual({ servers: 0, timers: 0, transports: 0, dbOpen: false });
  });

  it("redacts structured log secrets and serializes errors safely", () => {
    const lines: string[] = [];
    const logger = createLogger({ info: (line) => { lines.push(String(line)); }, warn: () => {}, error: () => {} });
    logger.info("request", { token: "secret", nested: { preimage: "hidden" }, error: new Error("safe message") });
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]).not.toContain("hidden");
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "request", token: "[REDACTED]", error: { message: "safe message" } });
  });
});
