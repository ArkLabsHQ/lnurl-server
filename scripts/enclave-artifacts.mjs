import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const schema = "lnurl.enclave.build.v1";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const hex = (size) => new RegExp(`^[0-9a-f]{${size}}$`);
const sri = /^sha256-[A-Za-z0-9+/]{43}=$/;
const comparable = ["revision", "sourceHash", "enclaveRevision", "target", "flakeLockSha256", "pnpmLockSha256", "profileSha256", "closureSha256", "eifSha256"];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function pcrs(input) {
  return Object.fromEntries(["PCR0", "PCR1", "PCR2"].map((key) => {
    const value = input?.[key];
    requireValue(typeof value === "string" && hex(96).test(value) && !/^0+$/.test(value), `invalid or debug ${key}`);
    return [key, value];
  }));
}

function validate(manifest) {
  requireValue(manifest?.schema === schema, "unsupported manifest schema");
  requireValue(manifest.target === "x86_64-linux", "unsupported target");
  for (const key of ["revision", "enclaveRevision"]) {
    requireValue(typeof manifest[key] === "string" && hex(40).test(manifest[key]), `invalid ${key}`);
  }
  requireValue(typeof manifest.sourceHash === "string" && sri.test(manifest.sourceHash), "invalid sourceHash");
  for (const key of comparable.filter((key) => key.endsWith("Sha256"))) {
    requireValue(typeof manifest[key] === "string" && hex(64).test(manifest[key]), `invalid ${key}`);
  }
  requireValue(typeof manifest.builder === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(manifest.builder), "missing or invalid builder evidence identifier");
  pcrs(manifest.pcrs);
  return manifest;
}

function create(args) {
  const names = ["root", "eif", "closure", "profile", "revision", "source-hash", "builder", "output"];
  const { values } = parseArgs({ args, options: Object.fromEntries(names.map((name) => [name, { type: "string" }])) });
  for (const name of names) requireValue(values[name], `--${name} is required`);
  const locks = readJson(join(values.root, "flake.lock"));
  const closure = readJson(values.closure);
  requireValue(closure && !Array.isArray(closure) && typeof closure === "object", "closure must be nix path-info --recursive --json output");
  const entries = Object.entries(closure).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, info]) => {
    requireValue(path.startsWith("/nix/store/") && sri.test(info?.narHash), "invalid closure entry");
    return [path, info.narHash];
  });
  requireValue(entries.length > 0, "empty application closure");
  const profile = readJson(values.profile);
  requireValue(profile && !Array.isArray(profile) && typeof profile === "object" && Object.values(profile).every((value) => typeof value === "string"), "profile must contain public string environment values");
  const manifest = validate({
    schema,
    revision: values.revision,
    sourceHash: values["source-hash"],
    enclaveRevision: locks.nodes?.enclave?.locked?.rev,
    target: "x86_64-linux",
    flakeLockSha256: sha256(readFileSync(join(values.root, "flake.lock"))),
    pnpmLockSha256: sha256(readFileSync(join(values.root, "pnpm-lock.yaml"))),
    profileSha256: sha256(readFileSync(values.profile)),
    closureSha256: sha256(JSON.stringify(entries)),
    eifSha256: sha256(readFileSync(join(values.eif, "image.eif"))),
    pcrs: pcrs(readJson(join(values.eif, "pcr.json"))),
    builder: values.builder,
  });
  writeFileSync(values.output, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  console.log(`Build evidence written to ${values.output}`);
}

function compare(paths) {
  requireValue(paths.length === 2, "compare requires two manifest paths");
  const [a, b] = paths.map((path) => validate(readJson(path)));
  requireValue(a.builder !== b.builder, "two distinct builder evidence identifiers are required");
  for (const key of comparable) requireValue(a[key] === b[key], `build mismatch: ${key}`);
  for (const key of ["PCR0", "PCR1", "PCR2"]) requireValue(a.pcrs[key] === b.pcrs[key], `build mismatch: ${key}`);
  console.log("Unsigned EIF, PCRs, application closure and build inputs match. Builder independence and release approval require separate verification.");
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create") create(args);
  else if (command === "compare") compare(args);
  else throw new Error("usage: enclave-artifacts.mjs create [options] | compare <first.json> <second.json>");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
