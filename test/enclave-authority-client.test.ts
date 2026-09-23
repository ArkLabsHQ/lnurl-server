import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AuthorityRefusal, AuthorityUnavailable, createAuthorityClient, type AuthorityClientOptions } from "../src/enclave/authority-client.js";
import { decodeCommit, encodeStatement, type CommitPayload, type StatementPayload } from "../src/enclave/authority-wire.js";

const DEPLOYMENT = "lnurl-test";
const NOW = 1_790_000_000_000;
const authorityKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const spki = authorityKey.publicKey.export({ type: "spki", format: "der" });
const keyId = createHash("sha256").update(spki).digest("hex");
const writer = generateKeyPairSync("ed25519");
const writerRaw = Buffer.from(writer.publicKey.export({ format: "jwk" }).x!, "base64url");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

function statement(over: Partial<StatementPayload> & { callerNonce: Uint8Array }, signer = authorityKey.privateKey) {
  const payload = encodeStatement({
    authorityKeyId: keyId, deployment: DEPLOYMENT, issuedAtUnixMs: NOW, activeEpoch: 1, activeWriterPublicKey: writerRaw,
    releasePolicyVersion: 1, sequence: 0, head: null, currentOperationId: null, ...over,
  });
  return { payload: Buffer.from(payload).toString("base64"), signature: sign("sha256", payload, signer).toString("base64") };
}

type Handler = (path: string, body: Record<string, string>) => { status: number; body: unknown } | "hang";
const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function authority(handler: Handler, options: Partial<AuthorityClientOptions> = {}) {
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const out = handler(req.url ?? "", JSON.parse(data || "{}"));
      if (out === "hang") return;
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return createAuthorityClient({
    url: `http://127.0.0.1:${port}/`, deployment: DEPLOYMENT, publicKeys: [spki], now: () => NOW, timeoutMs: 500, ...options,
  });
}

const nonce = Buffer.alloc(16, 0x5e);
const echoed = (body: Record<string, string>) => Buffer.from(body.nonce!, "hex");

describe("authority client", () => {
  it("accepts a statement that verifies for this deployment and this request", async () => {
    const client = await authority((_p, body) => ({ status: 200, body: { statement: statement({ callerNonce: echoed(body), sequence: 7 }) } }));
    expect(await client.state(nonce)).toMatchObject({ deployment: DEPLOYMENT, sequence: 7, activeEpoch: 1 });
  });

  it("verifies a statement the Go authority signed", async () => {
    const vector = JSON.parse(
      readFileSync(fileURLToPath(new URL("../authority/testdata/statement-signature.json", import.meta.url)), "utf8"),
    ) as { spki: string; payload: string; signature: string };
    const signed = { payload: Buffer.from(vector.payload, "hex").toString("base64"), signature: Buffer.from(vector.signature, "hex").toString("base64") };
    const client = await authority(() => ({ status: 200, body: { statement: signed } }), {
      deployment: "lnurl-prod", publicKeys: [Buffer.from(vector.spki, "base64")],
    });
    expect(await client.state(Buffer.alloc(16, 0x5f))).toMatchObject({ deployment: "lnurl-prod", activeEpoch: 3 });
  });

  it("refuses a statement it cannot stand behind", async () => {
    const stranger = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const strangerId = createHash("sha256").update(stranger.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const cases: [string, (n: Buffer) => unknown, RegExp][] = [
      ["signed by another key", (n) => statement({ callerNonce: n }, stranger.privateKey), /does not verify/],
      ["naming a key not pinned", (n) => statement({ callerNonce: n, authorityKeyId: strangerId }, stranger.privateKey), /not pinned/],
      ["for another deployment", (n) => statement({ callerNonce: n, deployment: "lnurl-other" }), /is for lnurl-other/],
      ["answering another request", () => statement({ callerNonce: Buffer.alloc(16, 0x01) }), /another request/],
      ["ten minutes stale", (n) => statement({ callerNonce: n, issuedAtUnixMs: NOW - 600_000 }), /skew/],
      ["truncated", (n) => ({ ...statement({ callerNonce: n }), payload: "AAAA" }), /unreadable/],
      ["missing", () => undefined, /no statement/],
    ];
    for (const [name, make, reason] of cases) {
      const client = await authority((_p, body) => ({ status: 200, body: { statement: make(echoed(body)) } }));
      await expect(client.state(nonce), name).rejects.toThrow(reason);
      await expect(client.state(nonce), name).rejects.toBeInstanceOf(AuthorityUnavailable);
    }
  });

  it("signs a commit with the writer key and holds the answer to that commit", async () => {
    const ciphertextDigest = "c3".repeat(32);
    const m: CommitPayload = {
      deployment: DEPLOYMENT, epoch: 1, operationId: "0f".repeat(16), expectedSequence: 0, priorDigest: null,
      head: {
        schema: "lnurl.enclave.checkpoint.v2", prefix: "lnurl/db", schemaVersion: 12, sealEpoch: 1, sequence: 1, previousDigest: null,
        digest: "d4".repeat(32), size: 4096, ciphertextDigest, key: `lnurl/db/${ciphertextDigest}.sqlite.br.enc`,
      },
    };
    let signedByWriter = false;
    const client = await authority((path, body) => {
      const payload = Buffer.from(body.payload!, "base64");
      signedByWriter = path === "/v1/checkpoint/commit" && verify(null, payload, writer.publicKey, Buffer.from(body.signature!, "base64"));
      const committed = decodeCommit(payload);
      return { status: 200, body: { statement: statement({ callerNonce: sha256(payload), sequence: 1, head: committed.head, currentOperationId: committed.operationId }) } };
    });
    expect(await client.commit(m, writer.privateKey)).toMatchObject({ sequence: 1, currentOperationId: m.operationId, head: { ciphertextDigest } });
    expect(signedByWriter).toBe(true);

    const replaying = await authority(() => ({ status: 200, body: { statement: statement({ callerNonce: sha256(Buffer.from("an earlier commit")) }) } }));
    await expect(replaying.commit(m, writer.privateKey)).rejects.toThrow(/another request/);
  });

  it("reports a refusal together with the authority's verified state", async () => {
    const client = await authority((_p, body) => ({
      status: 409,
      body: { error: "writer_fenced", message: "writer fenced by a successor", statement: statement({ callerNonce: echoed(body), activeEpoch: 2 }) },
    }));
    const refusal = await client.state(nonce).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(AuthorityRefusal);
    expect(refusal).toMatchObject({ code: "writer_fenced", current: { activeEpoch: 2 } });
  });

  it("tells a refusal from an outage", async () => {
    const unknown = await authority(() => ({ status: 404, body: { error: "unknown_deployment", message: "unknown deployment" } }));
    await expect(unknown.state(nonce)).rejects.toMatchObject({ code: "unknown_deployment" });
    const down = await authority(() => ({ status: 503, body: { error: "unavailable", message: "retry" } }));
    await expect(down.state(nonce)).rejects.toBeInstanceOf(AuthorityUnavailable);
    const hung = await authority(() => "hang");
    await expect(hung.state(nonce)).rejects.toBeInstanceOf(AuthorityUnavailable);
    const closed = createAuthorityClient({ url: "http://127.0.0.1:9", deployment: DEPLOYMENT, publicKeys: [spki], timeoutMs: 500 });
    await expect(closed.state(nonce)).rejects.toBeInstanceOf(AuthorityUnavailable);
  });
});
