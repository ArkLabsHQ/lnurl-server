import { describe, expect, it } from "vitest";
import { sendAmountFor } from "../src/send-amount.js";

describe("sendAmountFor", () => {
  it("takes the amount a pasted payment request asks for", () => {
    expect(sendAmountFor("bitcoin:?amount=0.0006336&ark=tark1qq", 1000)).toBe(63_360);
    expect(sendAmountFor("bitcoin:BCRT1QHDGN44AQWQMJ35QJ2D0Y0AC8VZGQNRVCYKP6NR?amount=0.0005&lightning=lnbcrt1", 1000)).toBe(50_000);
  });

  it("keeps the typed amount when the target asks for none", () => {
    for (const raw of ["tark1qqcpq7yq", "bitcoin:?ark=tark1qq", "bitcoin:?amount=0&ark=tark1qq", "alice@lnurl.mutinynet.arkade.sh", ""])
      expect(sendAmountFor(raw, 1234)).toBe(1234);
  });
});
