import { cpSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
  throw new Error("Usage: node scripts/check-client-sdk-compat.mjs <sdk-version>");
}
const dir = mkdtempSync(join(tmpdir(), "lnurl-client-sdk-"));
console.log(`Checking SDK ${version} in ${dir}`);
const client = JSON.parse(readFileSync(new URL("packages/client/package.json", root), "utf8"));
const repo = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const compiler = JSON.parse(readFileSync(new URL("tsconfig.json", root), "utf8")).compilerOptions;
cpSync(new URL("packages/client/src", root), join(dir, "src"), { recursive: true });
cpSync(new URL("packages/client/test", root), join(dir, "test"), { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({
  ...client,
  private: true,
  packageManager: repo.packageManager,
  dependencies: { ...client.dependencies, "@arkade-os/sdk": version },
  devDependencies: {
    typescript: repo.devDependencies.typescript,
    tsup: repo.devDependencies.tsup,
    vitest: repo.devDependencies.vitest,
    semver: "^7.7.3",
  },
}, null, 2));
writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
  compilerOptions: { ...compiler, rootDir: ".", lib: ["ES2022", "DOM"] },
  include: ["src", "test", "consumer.ts"],
}));
if (process.platform === "win32") {
  execFileSync("cmd.exe", ["/d", "/s", "/c", "pnpm install --prod=false --ignore-scripts"], { cwd: dir, stdio: "inherit" });
} else {
  execFileSync("pnpm", ["install", "--prod=false", "--ignore-scripts"], { cwd: dir, stdio: "inherit" });
}
const require = createRequire(join(dir, "package.json"));
const { satisfies } = require("semver");
const range = client.peerDependencies["@arkade-os/sdk"];
for (const [candidate, expected] of [["0.4.79", false], ["0.5.0-rc.0", true], ["0.5.0-rc.19", true], ["0.5.0", true], ["0.5.1", true]]) {
  if (satisfies(candidate, range) !== expected) throw new Error(`Unexpected SDK peer acceptance: ${candidate} (${range})`);
}
const run = (entry, args) => execFileSync(process.execPath, [join(dir, "node_modules", entry), ...args], { cwd: dir, stdio: "inherit" });
run("typescript/bin/tsc", ["--noEmit"]);
run("vitest/vitest.mjs", ["run"]);
run("tsup/dist/cli-default.js", ["src/index.ts", "src/arkade.ts", "--format", "esm", "--dts", "--external", "@arkade-os/sdk"]);
writeFileSync(join(dir, "consumer.ts"), `
import { createDefaultPaymentRouter, type Wallet } from '@arkade-os/sdk';
import { arkadeLnurl, type LnurlWallet, type LnurlPaymentRouter } from '@arkade-os/lnurl-client/arkade';
declare const wallet: Wallet;
const receiver: LnurlWallet = wallet;
const router: LnurlPaymentRouter = createDefaultPaymentRouter(wallet);
arkadeLnurl({ wallet: receiver, router, baseUrl: 'https://lnurl.example.com' });
`);
run("typescript/bin/tsc", ["--noEmit"]);
writeFileSync(join(dir, "smoke.mjs"), `
import { createLnurlClient } from '@arkade-os/lnurl-client';
const client = createLnurlClient({ fetchImpl: async () => new Response(JSON.stringify({
  tag: 'payRequest', callback: 'https://example.com/callback', minSendable: 1000,
  maxSendable: 1000000, metadata: '[["text/plain","alice"]]',
})) });
const pr = await client.resolve('alice@example.com');
if (pr.tag !== 'payRequest') throw new Error('Core smoke failed');
`);
const sdkPath = join(dir, "node_modules", "@arkade-os", "sdk");
const parkedSdkPath = join(dir, "sdk-parked");
renameSync(sdkPath, parkedSdkPath);
try {
  execFileSync(process.execPath, [join(dir, "smoke.mjs")], { cwd: dir, stdio: "inherit" });
} finally {
  renameSync(parkedSdkPath, sdkPath);
}
console.log(`SDK ${version}: types, client tests, build and consumer smoke passed`);
