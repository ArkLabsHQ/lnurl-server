import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

describe("cli", () => {
  it("reports an invalid configuration as one line, without a stack", () => {
    const run = spawnSync(process.execPath, ["--experimental-sqlite", "--import", "tsx", "src/cli.ts"], {
      env: { ...process.env, PORT: "3000", BASE_URL: "http://localhost:3000", MIN_SENDABLE: "5000", MAX_SENDABLE: "10", DB_PATH: "" },
      encoding: "utf8",
      timeout: 30_000,
    });
    const lines = run.stderr.split("\n").filter((l) => l && !/ExperimentalWarning|--trace-warnings/.test(l));
    expect(run.status).toBe(1);
    expect(lines).toEqual(["config: MAX_SENDABLE must be greater than or equal to MIN_SENDABLE"]);
  });
});
