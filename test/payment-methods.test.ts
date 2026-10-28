import { describe, it, expect } from "vitest";
import {
  isReservedMethodType,
  normalizePaymentMethods,
  parsePaymentMethods,
  serializePaymentMethods,
} from "../src/payment-methods.js";
import { RAIL_IDS } from "../src/rails.js";

describe("normalizePaymentMethods", () => {
  it("accepts a well-formed list", () => {
    expect(normalizePaymentMethods([{ type: "shielded", destination: "shrol21abc" }]))
      .toEqual([{ type: "shielded", destination: "shrol21abc" }]);
  });
  it("accepts an empty list as an explicit clear", () => {
    expect(normalizePaymentMethods([])).toEqual([]);
  });
  it.each(["Shielded", "1shielded", "shielded_x", "", "a".repeat(33), "has:colon"])(
    "refuses the malformed type %s", (type) => {
      expect(() => normalizePaymentMethods([{ type, destination: "x" }])).toThrow(/type/);
    });
  it("accepts a type at exactly 32 characters", () => {
    expect(normalizePaymentMethods([{ type: "a".repeat(32), destination: "x" }])).toHaveLength(1);
  });
  it.each(["lightning", "arkade", "onchain", "registered", "eip155", "solana", "tron"])(
    "refuses the reserved type %s", (type) => {
      expect(isReservedMethodType(type)).toBe(true);
      expect(() => normalizePaymentMethods([{ type, destination: "x" }])).toThrow(/reserved/);
    });
  it.each([...RAIL_IDS])("reserves the rail id %s, so a new rail fails here until it is listed", (id) => {
    expect(isReservedMethodType(id)).toBe(true);
    expect(() => normalizePaymentMethods([{ type: id, destination: "x" }])).toThrow(/reserved/);
  });
  it("refuses a destination that is empty, too long, or not printable ASCII", () => {
    expect(() => normalizePaymentMethods([{ type: "a", destination: "" }])).toThrow(/destination/);
    expect(() => normalizePaymentMethods([{ type: "a", destination: "x".repeat(513) }])).toThrow(/destination/);
    expect(() => normalizePaymentMethods([{ type: "a", destination: "has space" }])).toThrow(/destination/);
    expect(() => normalizePaymentMethods([{ type: "a", destination: "nul\u0000" }])).toThrow(/destination/);
  });
  it("accepts a destination at exactly 512 printable characters", () => {
    expect(normalizePaymentMethods([{ type: "a", destination: "x".repeat(512) }])[0]!.destination).toHaveLength(512);
  });
  it("draws the printable range at ! and ~", () => {
    expect(normalizePaymentMethods([{ type: "a", destination: "!~" }])).toHaveLength(1);
    for (const destination of ["\x7f", "é", "a\n", "a b"]) {
      expect(() => normalizePaymentMethods([{ type: "a", destination }])).toThrow(/destination/);
    }
  });
  it("refuses more than eight entries and accepts exactly eight", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => ({ type: `m${i}`, destination: "x" }));
    expect(normalizePaymentMethods(list(8))).toHaveLength(8);
    expect(() => normalizePaymentMethods(list(9))).toThrow(/at most 8/);
  });
  it("refuses a duplicate type", () => {
    expect(() => normalizePaymentMethods([{ type: "a", destination: "x" }, { type: "a", destination: "y" }]))
      .toThrow(/duplicate/);
  });
  it("refuses a non-array and an entry with extra or missing fields", () => {
    expect(() => normalizePaymentMethods("[]")).toThrow(/array/);
    expect(() => normalizePaymentMethods([{ type: "a" }])).toThrow(/destination/);
    expect(() => normalizePaymentMethods([{ destination: "x" }])).toThrow(/type/);
    expect(() => normalizePaymentMethods([{ type: "a", destination: "x", label: "y" }])).toThrow(/only type and destination/);
  });
  it("refuses an entry that is not an object", () => {
    for (const entry of [7, null, "a", ["a", "x"]]) {
      expect(() => normalizePaymentMethods([entry])).toThrow(/must be an object/);
    }
  });
});

describe("parsePaymentMethods", () => {
  it("round-trips through serializePaymentMethods", () => {
    const methods = [{ type: "shielded", destination: "shrol21abc" }];
    expect(parsePaymentMethods(serializePaymentMethods(methods))).toEqual(methods);
  });
  it("drops corrupt entries instead of throwing", () => {
    expect(parsePaymentMethods('[{"type":"a","destination":"x"},{"type":"B"},7,null]'))
      .toEqual([{ type: "a", destination: "x" }]);
    expect(parsePaymentMethods("not json")).toEqual([]);
    expect(parsePaymentMethods(null)).toEqual([]);
  });
  it("keeps the first entry of a repeated type", () => {
    expect(parsePaymentMethods('[{"type":"a","destination":"x"},{"type":"a","destination":"y"}]'))
      .toEqual([{ type: "a", destination: "x" }]);
    expect(parsePaymentMethods('[{"type":"a","destination":"x"},{"type":"b","destination":"z"},{"type":"a","destination":"y"}]'))
      .toEqual([{ type: "a", destination: "x" }, { type: "b", destination: "z" }]);
  });
  it("does not let a refused entry claim its type", () => {
    expect(parsePaymentMethods('[{"type":"a","destination":"has space"},{"type":"a","destination":"y"}]'))
      .toEqual([{ type: "a", destination: "y" }]);
  });
  it("applies the entry rules of normalizePaymentMethods", () => {
    expect(parsePaymentMethods('[{"type":"arkade","destination":"x"},{"type":"a","destination":"has space"},{"type":"b","destination":"y","extra":1}]'))
      .toEqual([]);
  });
  it("reads an already-parsed array and ignores anything that is not a list", () => {
    expect(parsePaymentMethods([{ type: "a", destination: "x" }, 7])).toEqual([{ type: "a", destination: "x" }]);
    expect(parsePaymentMethods('{"type":"a","destination":"x"}')).toEqual([]);
    expect(parsePaymentMethods(undefined)).toEqual([]);
  });
  it("stores only type and destination, whatever the caller handed over", () => {
    const wide = { type: "a", destination: "x", label: "y" };
    expect(serializePaymentMethods([wide])).toBe('[{"type":"a","destination":"x"}]');
    expect(parsePaymentMethods(serializePaymentMethods([wide]))).toEqual([{ type: "a", destination: "x" }]);
  });
});
