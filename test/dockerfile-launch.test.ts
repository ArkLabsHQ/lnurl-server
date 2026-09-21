import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");

/** The `CMD [...]` exec-form array the image actually runs. */
function dockerfileCmd(): string[] {
  const line = read("Dockerfile").split("\n").reverse().find((l) => l.startsWith("CMD ["));
  if (!line) throw new Error("no exec-form CMD in Dockerfile");
  return JSON.parse(line.slice("CMD ".length)) as string[];
}

// The image shipped without `--experimental-eventsource`, so every subscription threw and
// all three watchers fell back to a 20s poll. No suite caught it: each harness states its
// own argv, so the container's was the one launch nothing ever ran.
describe("the shipped container launch", () => {
  it("passes the flags the SDK needs, not just the ones the tests pass", () => {
    const cmd = dockerfileCmd();
    expect(cmd[0]).toBe("node");
    expect(cmd).toContain("--experimental-sqlite");
    expect(cmd).toContain("--experimental-eventsource");
    expect(cmd.at(-1)).toBe("dist/cli.js");
  });

  // The CMD alone was not enough: a host that starts the image with its own
  // command never sees it, and `pnpm start` carried the same gap the CMD did.
  it("carries the flag on every path that can start the server", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toContain("--experimental-eventsource");
    expect(read("Dockerfile")).toMatch(/ENV NODE_OPTIONS=.*--experimental-eventsource/);
  });

  it("matches the argv the e2e harness launches dist with", () => {
    const harness = read("packages/demo-wallet/e2e-local/local-stack.ts");
    const distArgv = harness.slice(harness.indexOf('opts.entry === "dist"'));
    for (const flag of dockerfileCmd().filter((a) => a.startsWith("--"))) {
      expect(distArgv.slice(0, 200)).toContain(flag);
    }
  });
});
