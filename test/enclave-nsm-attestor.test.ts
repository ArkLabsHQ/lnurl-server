import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nsmAttestor } from "../src/enclave/nsm-attestor.js";

// Stands in for attestor/cmd/lnurl-attest: argv[2] picks how it behaves.
const FAKE_HELPER = `
const mode = process.argv[2];
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const bytes = (s) => Buffer.from(s, "base64");
  if (mode === "echo") process.stdout.write(Buffer.concat([bytes(req.nonce), bytes(req.userData)]).toString("base64") + "\\n");
  else if (mode === "fail") { process.stderr.write("lnurl-attest: open NSM session: open /dev/nsm: no such file or directory\\n"); process.exit(1); }
  else if (mode === "hang") setInterval(() => {}, 1000);
  else if (mode === "garbage") process.stdout.write("not base64!!\\n");
  else if (mode === "flood") process.stdout.write("A".repeat(200_000));
  else if (mode === "env") process.stdout.write(Buffer.from(JSON.stringify(Object.keys(process.env))).toString("base64"));
});
`;

let dir: string;
let helper: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nsm-attestor-"));
  helper = join(dir, "fake-helper.cjs");
  writeFileSync(helper, FAKE_HELPER);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const attestor = (mode: string, timeoutMs?: number) =>
  nsmAttestor(process.execPath, [helper, mode], timeoutMs === undefined ? {} : { timeoutMs });
const input = { nonce: new Uint8Array(32).fill(1), userData: new Uint8Array(32).fill(2) };

describe("nsmAttestor", () => {
  it("hands the helper exactly the nonce and user data, and returns the document it prints", async () => {
    const document = await attestor("echo").quote(input);
    expect(document).toEqual(new Uint8Array([...input.nonce, ...input.userData]));
  });

  it("gives the helper none of this process's environment", async () => {
    process.env.LNURL_ATTESTOR_TEST_SECRET = "must-not-leak";
    try {
      const keys = JSON.parse(Buffer.from(await attestor("env").quote(input)).toString()) as string[];
      expect(keys).not.toContain("LNURL_ATTESTOR_TEST_SECRET");
    } finally {
      delete process.env.LNURL_ATTESTOR_TEST_SECRET;
    }
  });

  it("carries the helper's reason when it fails", async () => {
    await expect(attestor("fail").quote(input)).rejects.toThrow(/exited 1: lnurl-attest: open NSM session: open \/dev\/nsm/);
  });

  it("refuses output that is not a document", async () => {
    await expect(attestor("garbage").quote(input)).rejects.toThrow(/no document/);
    await expect(attestor("flood").quote(input)).rejects.toThrow(/more output/);
  });

  it("kills a helper that never answers", async () => {
    const started = Date.now();
    await expect(attestor("hang", 300).quote(input)).rejects.toThrow(/timed out after 300 ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a helper that cannot start", async () => {
    await expect(nsmAttestor(join(dir, "missing-helper")).quote(input)).rejects.toThrow(/could not start/);
  });
});
