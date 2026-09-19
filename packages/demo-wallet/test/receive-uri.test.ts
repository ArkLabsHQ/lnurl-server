import { describe, expect, it } from "vitest";
import { receiveUri } from "../src/Qr.js";

const ADDRESS = "alice@lnurl.mutinynet.arkade.sh";

describe("receiveUri", () => {
  it("offers the lightning address, and nothing else", () => {
    expect(receiveUri(ADDRESS)).toBe(`lightning:${ADDRESS}`);
  });

  // The wallet publishes no Arkade or boarding address: a payer resolves the
  // address and asks it for the rail they want, so a unified URI would be this
  // page asserting rails it is not the source of truth for.
  it("names no other rail", () => {
    const uri = receiveUri(ADDRESS);
    expect(uri).not.toContain("bitcoin:");
    expect(uri).not.toContain("ark=");
  });
});
