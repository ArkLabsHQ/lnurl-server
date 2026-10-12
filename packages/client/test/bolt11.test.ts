import { describe, it, expect } from "vitest";
import { bech32, hex } from "@scure/base";
import { paymentHashOf } from "../src/bolt11.js";
import { parseVerifyStatus } from "../src/payer.js";
import { HASH, PREIMAGE } from "./invoice.js";

const OTHER = "9a".repeat(32);
const hashWords = (h: string) => bech32.toWords(hex.decode(h));
const p = (data: number[]) => [1, data.length >> 5, data.length & 31, ...data];
const encode = (...fields: number[][]) =>
  bech32.encode("lnbc", [...new Array<number>(7).fill(0), ...fields.flat(), ...new Array<number>(104).fill(0)], 2000);

describe("paymentHashOf", () => {
  it("takes the first of two p fields", () => {
    expect(paymentHashOf(encode(p(hashWords(HASH)), p(hashWords(OTHER))))).toBe(HASH);
  });

  it("skips a p field whose length is not 52 and takes the next valid one", () => {
    expect(paymentHashOf(encode(p([...hashWords(HASH), 0]), p(hashWords(OTHER))))).toBe(OTHER);
  });

  it("returns null when the only p field is the wrong length", () => {
    expect(paymentHashOf(encode(p([...hashWords(HASH), 0])))).toBeNull();
  });
});

describe("parseVerifyStatus", () => {
  it("refuses a settled claim proven against a p field payers would skip", () => {
    const pr = encode(p([...hashWords(HASH), 0]), p(hashWords(OTHER)));
    expect(() => parseVerifyStatus({ pr, settled: true, preimage: PREIMAGE })).toThrow(/payment hash/);
  });
});
