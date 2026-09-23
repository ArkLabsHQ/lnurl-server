import { describe, expect, it } from "vitest";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeStatement } from "../src/enclave/authority-wire.js";

const vector = JSON.parse(
  readFileSync(fileURLToPath(new URL("../authority/testdata/statement-signature.json", import.meta.url)), "utf8"),
) as { spki: string; keyId: string; payload: string; signature: string };

const spki = Buffer.from(vector.spki, "base64");
const key = createPublicKey({ key: spki, format: "der", type: "spki" });
const payload = Buffer.from(vector.payload, "hex");
const signature = Buffer.from(vector.signature, "hex");

describe("authority statement signatures", () => {
  it("verifies a statement the Go authority signed", () => {
    expect(verify("sha256", payload, key, signature)).toBe(true);
  });

  it("refuses that signature over any other payload", () => {
    const altered = Buffer.from(payload);
    altered[altered.length - 1]! ^= 0x01;
    expect(verify("sha256", altered, key, signature)).toBe(false);
  });

  it("names the signing key by the SHA-256 of its SPKI encoding, inside the signed bytes", () => {
    expect(createHash("sha256").update(spki).digest("hex")).toBe(vector.keyId);
    expect(decodeStatement(payload).authorityKeyId).toBe(vector.keyId);
  });
});
