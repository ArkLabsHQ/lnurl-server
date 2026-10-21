import { describe, expect, it } from "vitest";
import type { ProvisioningCode } from "../src/errors.js";
import type { LnurlAddressErrorCode } from "../packages/client/src/index.js";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("LnurlAddressErrorCode", () => {
  it("names exactly the codes the server's address endpoints answer with", () => {
    const same: Same<ProvisioningCode, LnurlAddressErrorCode> = true;
    expect(same).toBe(true);
  });
});
