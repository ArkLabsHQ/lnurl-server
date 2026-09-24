import { describe, expect, it } from "vitest";
import { nameChoices } from "../src/name-choice.js";

describe("nameChoices", () => {
  it("offers a claim code only where the operator reserves names", () => {
    expect(nameChoices(["self"], { nameless: true }).claimCode).toBe(false);
    expect(nameChoices(["self", "admin"], { nameless: true }).claimCode).toBe(true);
  });

  it("offers a claim code on an admin-only domain, and nothing self-service", () => {
    expect(nameChoices(["admin"], { nameless: true })).toEqual({ self: false, random: false, nameless: false, claimCode: true });
  });

  it("drops the nameless choice where a name is being added", () => {
    const all = ["self", "random", "session", "admin"];
    expect(nameChoices(all, { nameless: true })).toEqual({ self: true, random: true, nameless: true, claimCode: true });
    expect(nameChoices(all, { nameless: false }).nameless).toBe(false);
  });
});
