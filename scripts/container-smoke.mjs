import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const image = process.argv[2];
if (!image) throw new Error("usage: node scripts/container-smoke.mjs <image>");

const key = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const dir = await mkdtemp(join(tmpdir(), "lnurl-container-"));
const cardPath = join(dir, "solver-cards.json");
const name = `lnurl-smoke-${process.pid}`;
const volume = `${name}-data`;
let containerId;

const dependency = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/v1/info") res.end(JSON.stringify({ network: "regtest", signerPubkey: key, unilateralExitDelay: "86400" }));
  else if (req.url === "/v1/preimage/covclaimd-pubkey") res.end(JSON.stringify({ covclaimd_pub_key: key, emulator_pub_key: key }));
  else { res.statusCode = 404; res.end("{}"); }
});
await new Promise((resolve) => dependency.listen(0, "0.0.0.0", resolve));
const dependencyPort = dependency.address().port;

const card = [{
  version: 0,
  name: "smoke-solver",
  discovery_pubkey: "11".repeat(32),
  sig: "22".repeat(64),
  transports: { nostr: { relays: ["wss://relay.invalid"] } },
  markets: [{
    base_asset: { id: "arkade:regtest/slip44:1", name: "Bitcoin", ticker: "BTC", decimals: 8 },
    quote_asset: { id: "bolt11:regtest/slip44:1", name: "Bitcoin", ticker: "BTC", decimals: 8 },
    fee_bps: 10,
    min_base_amount: "1", max_base_amount: "1000000",
    min_quote_amount: "1", max_quote_amount: "1000000",
  }],
}];
await writeFile(cardPath, JSON.stringify(card));

try {
  await exec("docker", ["volume", "create", volume]);
  const run = await exec("docker", [
    "run", "-d", "--rm", "--name", name,
    "-p", "127.0.0.1::3000",
    "--add-host", "host.docker.internal:host-gateway",
    "--mount", `type=volume,src=${volume},dst=/data`,
    "--mount", `type=bind,src=${cardPath},dst=/run/solver-cards.json,readonly`,
    "-e", "DB_PATH=/data/lnurl.sqlite",
    "-e", "ALLOW_INSECURE_TOKEN_STORAGE=1",
    "-e", "BASE_URL=http://localhost:3000",
    "-e", "SOLVER_CARDS_FILE=/run/solver-cards.json",
    "-e", `ARK_SERVER_URL=http://host.docker.internal:${dependencyPort}`,
    "-e", `COVCLAIMD_URL=http://host.docker.internal:${dependencyPort}`,
    image,
  ]);
  containerId = run.stdout.trim();
  const port = (await exec("docker", ["port", name, "3000/tcp"])).stdout.trim().split(":").at(-1);
  const base = `http://127.0.0.1:${port}`;
  let response;
  for (let i = 0; i < 60; i++) {
    response = await fetch(`${base}/readyz`).catch(() => undefined);
    if (response?.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!response?.ok) throw new Error(`readyz did not become healthy: ${response?.status ?? "unreachable"}`);
  const uid = (await exec("docker", ["exec", name, "id", "-u"])).stdout.trim();
  if (uid === "0") throw new Error("container runs as root");
  const healthcheck = JSON.parse((await exec("docker", ["inspect", "--format", "{{json .Config.Healthcheck}}", name])).stdout);
  if (!healthcheck?.Test) throw new Error("image has no healthcheck");
  console.log(`container smoke passed: uid=${uid}, readyz=200`);
} finally {
  dependency.closeAllConnections();
  await new Promise((resolve) => dependency.close(resolve));
  if (containerId) await exec("docker", ["rm", "-f", name]).catch(() => {});
  await exec("docker", ["volume", "rm", volume]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
