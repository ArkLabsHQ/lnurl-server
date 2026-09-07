import { describe, it, expect } from "vitest";
import { pollUntil } from "./e2e/support/regtest.js";

const never = async () => false;

const messageOf = (p: Promise<void>): Promise<string> => p.then(() => "(did not throw)", (e: Error) => e.message);

describe("pollUntil", () => {
  it("names the timeout without an explain callback", async () => {
    await expect(pollUntil("verify settled", never, 0, 1)).rejects.toThrow("verify settled not ready within 0s");
  });

  it("appends the explain callback's context to the timeout", async () => {
    await expect(pollUntil("verify settled", never, 0, 1, () => "swap abc123 stuck at funded for 663s")).rejects.toThrow(
      "verify settled not ready within 0s — swap abc123 stuck at funded for 663s",
    );
  });

  it("still reports the timeout when the explain callback throws", async () => {
    const boom = () => {
      throw new Error("solver unreachable");
    };
    expect(await messageOf(pollUntil("verify settled", never, 0, 1, boom))).toBe("verify settled not ready within 0s");
  });

  it("omits the separator when explain returns undefined", async () => {
    expect(await messageOf(pollUntil("verify settled", never, 0, 1, () => undefined))).toBe(
      "verify settled not ready within 0s",
    );
  });

  it("does not call explain when the condition passes", async () => {
    let called = false;
    await pollUntil("ready", async () => true, 0, 1, () => {
      called = true;
      return "unused";
    });
    expect(called).toBe(false);
  });
});
