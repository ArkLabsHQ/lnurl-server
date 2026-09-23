import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  decodeActivate, decodeCommit, decodeStatement, encodeActivate, encodeCommit, encodeStatement,
  type ActivatePayload, type CommitPayload, type StatementPayload, type WireHead,
} from "../src/enclave/authority-wire.js";

type Kind = "activate" | "commit" | "statement";
interface Vector { name: string; kind: Kind; message: Record<string, unknown>; hex: string }

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../authority/testdata/wire-vectors.json", import.meta.url)), "utf8"),
) as Vector[];
const BYTE_FIELDS = new Set(["challengeNonce", "writerPublicKey", "callerNonce", "activeWriterPublicKey"]);

const fromJson = (message: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(message).map(([k, v]) => [k, BYTE_FIELDS.has(k) ? Uint8Array.from(Buffer.from(v as string, "hex")) : v]));
const toJson = (message: object) =>
  Object.fromEntries(Object.entries(message).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v]));

function encode(kind: Kind, message: object): Uint8Array {
  if (kind === "activate") return encodeActivate(message as ActivatePayload);
  if (kind === "commit") return encodeCommit(message as CommitPayload);
  return encodeStatement(message as StatementPayload);
}

function decode(kind: Kind, payload: Uint8Array): object {
  if (kind === "activate") return decodeActivate(payload);
  if (kind === "commit") return decodeCommit(payload);
  return decodeStatement(payload);
}

function head(sequence: number, previousDigest: string | null): WireHead {
  const ciphertextDigest = "c3".repeat(32);
  return {
    schema: "lnurl.enclave.checkpoint.v2", prefix: "lnurl/db", schemaVersion: 12, sealEpoch: 1, sequence, previousDigest,
    digest: "d4".repeat(32), size: 1_310_720, ciphertextDigest, key: `lnurl/db/${ciphertextDigest}.sqlite.br.enc`,
  };
}

const activation = (deployment: string, challengeId: string): ActivatePayload => ({
  deployment, challengeId, challengeNonce: new Uint8Array(20), writerPublicKey: new Uint8Array(32), releasePolicyVersion: 1, restored: null,
});
const commit = (epoch: number, h = head(1, null)): CommitPayload => ({
  deployment: "lnurl-prod", epoch, operationId: "0f".repeat(16), expectedSequence: 0, priorDigest: null, head: h,
});

describe("authority wire encoding", () => {
  it("has the Go encoder's vectors to hold itself to", () => {
    expect(vectors.map((v) => v.kind).sort()).toEqual(["activate", "activate", "commit", "commit", "statement", "statement"]);
  });

  for (const v of vectors) {
    it(`encodes and decodes ${v.name} byte for byte as Go does`, () => {
      expect(Buffer.from(encode(v.kind, fromJson(v.message))).toString("hex")).toBe(v.hex);
      expect(toJson(decode(v.kind, Buffer.from(v.hex, "hex")))).toEqual(v.message);
    });
  }

  it("keeps fields apart with their length prefixes", () => {
    expect(Buffer.from(encodeActivate(activation("ab", "c")))).not.toEqual(Buffer.from(encodeActivate(activation("a", "bc"))));
  });

  it("refuses integers TypeScript cannot hold exactly", () => {
    expect(() => encodeCommit(commit(Number.MAX_SAFE_INTEGER + 1))).toThrow(/safe integer/);
    const payload = Buffer.from(encodeCommit(commit(Number.MAX_SAFE_INTEGER)));
    const at = payload.indexOf(Buffer.from("001fffffffffffff", "hex"));
    expect(at).toBeGreaterThan(0);
    Buffer.from("0020000000000000", "hex").copy(payload, at);
    expect(() => decodeCommit(payload)).toThrow(/exceeds 2\^53-1/);
  });

  it("refuses truncated or trailing payloads", () => {
    const payload = encodeCommit(commit(1));
    expect(() => decodeCommit(payload.subarray(0, payload.length - 1))).toThrow(/truncated/);
    expect(() => decodeCommit(Buffer.concat([payload, Uint8Array.of(0)]))).toThrow(/trailing/);
  });

  it("refuses another message's payload", () => {
    expect(() => decodeCommit(encodeActivate(activation("lnurl-prod", "ch-01")))).toThrow(/tag/);
  });

  it("refuses a head whose key names another object", () => {
    expect(() => encodeCommit(commit(1, { ...head(1, null), key: `lnurl/db/${"ee".repeat(32)}.sqlite.br.enc` }))).toThrow(/key/);
  });

  it("refuses text outside printable ASCII, lone surrogates included", () => {
    for (const deployment of ["lnurl-ü", "lnurl\n", "lnurl-\ud800"]) {
      expect(() => encodeActivate(activation(deployment, "ch-01"))).toThrow(/printable ASCII/);
    }
  });
});
