import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/enclave-artifacts.mjs");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lnurl-eif-test-"));
  roots.push(root);
  mkdirSync(join(root, "eif"));
  writeFileSync(join(root, "eif/image.eif"), "unsigned test image");
  writeFileSync(join(root, "eif/pcr.json"), JSON.stringify({ PCR0: "ab".repeat(48), PCR1: "cd".repeat(48), PCR2: "ef".repeat(48) }));
  writeFileSync(join(root, "closure.json"), JSON.stringify({ "/nix/store/app": { narHash: "sha256-" + Buffer.alloc(32, 1).toString("base64") } }));
  writeFileSync(join(root, "flake.lock"), JSON.stringify({ nodes: { enclave: { locked: { rev: "a".repeat(40) } } } }));
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(root, "profile.json"), JSON.stringify({ ENCLAVE_DEPLOYMENT: "research", ENCLAVE_APP_NAME: "lnurl" }));
  return root;
}

function manifest(root: string, builder = "runner-a") {
  const output = join(root, `${builder}.json`);
  execFileSync(process.execPath, [script, "create", "--root", root, "--eif", join(root, "eif"), "--closure", join(root, "closure.json"), "--profile", join(root, "profile.json"), "--revision", "1".repeat(40), "--source-hash", "sha256-" + Buffer.alloc(32, 2).toString("base64"), "--builder", builder, "--output", output]);
  return output;
}

function compare(a: string, b: string) {
  return spawnSync(process.execPath, [script, "compare", a, b], { encoding: "utf8" });
}

// Every case here shells out to the artifact CLI two to four times, which runs past
// the default budget on a loaded runner.
describe("enclave reproducibility evidence", { timeout: 30_000 }, () => {
  it("compares independently identified builds with identical inputs and outputs", () => {
    const root = fixture();
    const result = compare(manifest(root), manifest(root, "runner-b"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("match");
  });

  it.each(["eifSha256", "closureSha256", "sourceHash", "revision", "flakeLockSha256", "pnpmLockSha256", "profileSha256", "enclaveRevision"])("rejects changed %s", (field) => {
    const root = fixture();
    const a = manifest(root);
    const b = manifest(root, "runner-b");
    const data = JSON.parse(readFileSync(b, "utf8"));
    data[field] = field === "sourceHash" ? "sha256-" + Buffer.alloc(32, 3).toString("base64") : "c".repeat(field.endsWith("Revision") || field === "revision" ? 40 : 64);
    writeFileSync(b, JSON.stringify(data));
    expect(compare(a, b).status).not.toBe(0);
  });

  it.each(["PCR0", "PCR1", "PCR2"])("rejects changed %s", (pcr) => {
    const root = fixture();
    const a = manifest(root);
    const b = manifest(root, "runner-b");
    const data = JSON.parse(readFileSync(b, "utf8"));
    data.pcrs[pcr] = "01".repeat(48);
    writeFileSync(b, JSON.stringify(data));
    expect(compare(a, b).status).not.toBe(0);
  });

  it("refuses one build presented twice", () => {
    const a = manifest(fixture());
    expect(compare(a, a).status).not.toBe(0);
  });

  it("refuses missing evidence and zero debug measurements", () => {
    const root = fixture();
    const a = manifest(root);
    const b = manifest(root, "runner-b");
    const data = JSON.parse(readFileSync(b, "utf8"));
    delete data.closureSha256;
    writeFileSync(b, JSON.stringify(data));
    expect(compare(a, b).status).not.toBe(0);
    writeFileSync(join(root, "eif/pcr.json"), JSON.stringify({ PCR0: "0".repeat(96), PCR1: "cd".repeat(48), PCR2: "ef".repeat(48) }));
    expect(() => manifest(root, "runner-c")).toThrow();
  });
});
