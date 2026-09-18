import { describe, expect, it } from "vitest";
import { BIP21 } from "@arkade-os/sdk";
import { receiveUri } from "../src/Qr.js";

const ADDRS = {
  lightningAddress: "alice@lnurl.mutinynet.arkade.sh",
  arkadeAddress: "tark1qexample",
  boardingAddress: "tb1qboarding",
};

describe("receiveUri", () => {
  it("offers the bare lightning address on its own", () => {
    expect(receiveUri("lightning", ADDRS)).toBe("lightning:alice@lnurl.mutinynet.arkade.sh");
  });

  it("carries all three rails in the unified form", () => {
    const parsed = BIP21.parse(receiveUri("unified", ADDRS));

    expect(parsed.params.address).toBe(ADDRS.boardingAddress);
    expect(parsed.params.ark).toBe(ADDRS.arkadeAddress);
    // The LUD-16 address, not a bolt11: this page holds no invoice, and an
    // address is payable at any amount.
    expect(parsed.params.lightning).toBe(ADDRS.lightningAddress);
  });

  it("round-trips the address through URI encoding", () => {
    // The `@` percent-encodes; a wallet reading it back must see the original.
    const uri = receiveUri("unified", ADDRS);
    expect(uri).toContain("%40");
    expect(BIP21.parse(uri).params.lightning).toBe(ADDRS.lightningAddress);
  });
});
