import { describe, expect, it } from "vitest";
import { sendAmountFor } from "../src/send-amount.js";

describe("sendAmountFor", () => {
  it("takes the amount a pasted payment request asks for", () => {
    expect(sendAmountFor("bitcoin:?amount=0.0006336&ark=tark1qq", 1000)).toBe(63_360);
    expect(sendAmountFor("bitcoin:BCRT1QHDGN44AQWQMJ35QJ2D0Y0AC8VZGQNRVCYKP6NR?amount=0.0005&lightning=lnbcrt1", 1000)).toBe(50_000);
  });

  it("falls back to the invoice's own amount, after amount=", () => {
    const invoice = "lntbs60020n1p4vt7d3pp5n7hcxe4650eatxe3ap4eqzjt8am6ldzzs0lzhm63yy6rfklptl8sdqqcqzpkxqrpc8sp5hrhtzvzwqq3qxcfuushmeqh0kw05ym3alhm3l73aeufcea42hh3q9qxpqysgqgks7jz3nm8l5lz4v9y7cwc682nza8j8j3q6k4ez6qg077utxy0hnh3k3gy3ek7ejn4kf55ljrwh2ytr2xvyx2y7aqldjclkjh5qklegqxtquau";
    expect(sendAmountFor(invoice, 1000)).toBe(6002);
    expect(sendAmountFor(`bitcoin:?lightning=${invoice}`, 1000)).toBe(6002);
    expect(sendAmountFor(`bitcoin:?lightning=${invoice}&amount=0.00005936`, 1000)).toBe(5936);
  });

  it("keeps the typed amount when the target asks for none", () => {
    for (const raw of ["tark1qqcpq7yq", "bitcoin:?ark=tark1qq", "bitcoin:?amount=0&ark=tark1qq", "alice@lnurl.mutinynet.arkade.sh", ""])
      expect(sendAmountFor(raw, 1234)).toBe(1234);
  });
});
