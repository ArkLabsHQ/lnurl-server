import { describe, it, expect } from "vitest";
import { requestInvoice } from "../src/payer.js";
import { tokenOptions } from "../src/token-options.js";
import { normalizeTokenQuote, payableTokenUri, requestTokenQuote, tokenOptionAccepts } from "../src/token-quotes.js";
import type { DestinationResult, InvoiceResult, PayRequest } from "../src/types.js";

const CONTRACT = "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9";
const DEPOSIT = "0x" + "ab".repeat(20);
const OTHER = "0x" + "cd".repeat(20);
const payRequest: PayRequest = {
  tag: "payRequest", callback: "https://lnurl.test/callback", metadata: "[]",
  minSendable: 1000, maxSendable: 100_000_000,
  source: { url: "https://lnurl.test/.well-known/lnurlp/alice", surface: "address" },
  units: [{ code: "USDT", decimals: 6 }],
  paymentOptions: [{ id: "usdt", type: "eip155", asset: `eip155:42161/erc20:${CONTRACT}`, unit: "USDT" }],
};
const token = tokenOptions(payRequest)[0]!;
const uri = (recipient = DEPOSIT, amount = "8426000", chain = "42161", contract = CONTRACT) =>
  `ethereum:${contract}@${chain}/transfer?address=${recipient}&uint256=${amount}`;
const answer = (overrides: Partial<DestinationResult> = {}): DestinationResult => ({
  kind: "destination", paymentOption: "usdt", paymentDestination: DEPOSIT, paymentURI: uri(),
  paymentQuote: { expiresAt: "2030-01-01T00:00:00.000Z", requested: { amount: "10000000", unit: "msat" }, payment: { amount: "8426000", unit: "USDT" } },
  ...overrides,
});
const ask = (body: DestinationResult) => requestInvoice(payRequest, { amountSat: 10_000, paymentOption: token.id },
  async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));

describe("requestInvoice token URI binding", () => {
  it("replaces a callback URI for another recipient with the validated deposit", async () => {
    expect(await ask(answer({ paymentURI: uri(OTHER) }))).toMatchObject({ paymentURI: DEPOSIT });
  });

  it("preserves absent URI and expiry fields for existing callers", async () => {
    const body = answer();
    delete body.paymentURI;
    delete body.paymentQuote!.expiresAt;
    expect(await ask(body)).toEqual(body);
  });

  it("still validates the token when the callback supplies no URI", async () => {
    await expect(ask(answer({ paymentURI: undefined, paymentDestination: "wrong" }))).rejects.toThrow(/eip155 address/);
  });

  it("keeps expired quote handling with the caller", async () => {
    const body = answer();
    body.paymentQuote!.expiresAt = "2000-01-01T00:00:00.000Z";
    expect(await ask(body)).toEqual(body);
  });
});

describe("payableTokenUri", () => {
  it("retains a transfer of exactly the Ethereum token, chain, destination and base units", () => {
    expect(payableTokenUri(token, answer())).toBe(uri());
    expect(payableTokenUri(token, answer({ paymentURI: uri(DEPOSIT.toUpperCase().replace("0X", "0x")) })))
      .toBe(uri(DEPOSIT.toUpperCase().replace("0X", "0x")));
  });

  it.each([
    uri(OTHER), uri(DEPOSIT, "8426001"), uri(DEPOSIT, "8426000", "1"), uri(DEPOSIT, "8426000", "42161", OTHER),
    uri().replace("@42161", ""), uri() + `&address=${OTHER}`, uri() + `&address=${DEPOSIT}`,
    uri() + "&uint256=8426000", uri() + "&value=1000000000000000000", uri().replace("/transfer", "/approve"),
    `https://evil.test/${DEPOSIT}`, "not a URI", "",
  ])("falls back to the validated deposit for unsafe instruction %s", (paymentURI) => {
    expect(payableTokenUri(token, answer({ paymentURI }))).toBe(DEPOSIT);
  });

  it("allows Ethereum mainnet's omitted chain id only for a mainnet option", () => {
    const mainnet = { ...token, asset: { ...token.asset, chainReference: "1", chainId: "eip155:1" } };
    const paymentURI = uri().replace("@42161", "");
    expect(payableTokenUri(mainnet, answer({ paymentURI }))).toBe(paymentURI);
  });

  it("falls back when the supported Ethereum transfer cannot encode a required memo", () => {
    expect(payableTokenUri(token, answer({ paymentDestinationTag: "order-42" }))).toBe(DEPOSIT);
  });

  const solRecipient = "11111111111111111111111111111111";
  const solMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const solToken = tokenOptions({
    units: [{ code: "USDC", decimals: 6 }],
    paymentOptions: [{ id: "sol", type: "solana", asset: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:${solMint}`, unit: "USDC" }],
  })[0]!;
  const solUri = `solana:${solRecipient}?spl-token=${solMint}&amount=8.426000`;
  const solAnswer = (paymentURI = solUri): DestinationResult => ({
    ...answer(), paymentOption: "sol", paymentDestination: solRecipient, paymentURI,
    paymentQuote: { ...answer().paymentQuote!, payment: { amount: "8426000", unit: "USDC" } },
  });

  it("retains an exact Solana Pay SPL transfer including its memo", () => {
    expect(payableTokenUri(solToken, solAnswer(solUri + "&memo=order-42"))).toBe(solUri + "&memo=order-42");
    expect(payableTokenUri(solToken, solAnswer(solUri.replace("8.426000", "8.426")))).toBe(solUri.replace("8.426000", "8.426"));
  });

  it.each(["", "&memo=other-order", "&memo=order-42&memo=other-order", "&memo=order-42&memo=order-42"])(
    "falls back when a required Solana memo is missing, wrong or ambiguous: %s", (memo) => {
      expect(payableTokenUri(solToken, { ...solAnswer(solUri + memo), paymentDestinationTag: "order-42" })).toBe(solRecipient);
    },
  );

  it("rejects duplicate Solana memo fields even without a required memo", () => {
    expect(payableTokenUri(solToken, solAnswer(solUri + "&memo=order-42&memo=other-order"))).toBe(solRecipient);
  });

  it("retains a matching required Solana memo and optional payment metadata", () => {
    const paymentURI = solUri + "&memo=order-42&label=Shop&message=Thanks&reference=ref1&reference=ref2";
    const body = { ...solAnswer(paymentURI), paymentDestinationTag: "order-42" };
    expect(payableTokenUri(solToken, body)).toBe(paymentURI);
    expect(normalizeTokenQuote(solToken, body, Date.parse("2029-01-01T00:00:00Z")))
      .toMatchObject({ value: paymentURI, paymentDestinationTag: "order-42" });
  });

  it.each([
    solUri + "&amount=8.426", solUri + `&spl-token=${solMint}`, solUri.replace("8.426000", "8.427"),
    solUri.replace(`spl-token=${solMint}`, `spl-token=${solRecipient}`), solUri.replace(`solana:${solRecipient}`, `solana:${solMint}`),
    solUri.replace("8.426000", "8.426e0"),
  ])("refuses a mismatched or ambiguous Solana Pay transfer %s", (paymentURI) => {
    expect(payableTokenUri(solToken, solAnswer(paymentURI))).toBe(solRecipient);
  });

  it("uses a bare address on chains without a recognized payment URI", () => {
    const tron = tokenOptions({ units: payRequest.units, paymentOptions: [{
      id: "tron", type: "tron", asset: "tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", unit: "USDT",
    }] })[0]!;
    const destination = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    expect(payableTokenUri(tron, answer({ paymentOption: "tron", paymentDestination: destination }))).toBe(destination);
  });
});

describe("normalizeTokenQuote", () => {
  const now = Date.parse("2029-12-31T23:59:59.999Z");

  it("returns the exact amount, safe instruction, deadline and optional memo", () => {
    expect(normalizeTokenQuote(token, answer({ paymentURI: uri(OTHER), paymentDestinationTag: "order-42" }), now)).toEqual({
      optionId: "usdt", destination: DEPOSIT, baseUnits: "8426000", amount: "8.426", value: DEPOSIT,
      expiresAt: Date.parse("2030-01-01T00:00:00.000Z"), paymentDestinationTag: "order-42",
    });
    expect(normalizeTokenQuote(token, answer(), now)).not.toHaveProperty("paymentDestinationTag");
  });

  it("formats large integer amounts exactly through 36 decimal places", () => {
    const highPrecision = { ...token, unit: { ...token.unit, decimals: 36 } };
    const body = answer();
    body.paymentQuote!.payment.amount = "123456789012345678901234567890123456789012345678901234567890123456789012345678";
    expect(normalizeTokenQuote(highPrecision, body, now).amount)
      .toBe("123456789012345678901234567890123456789012.345678901234567890123456789012345678");
  });

  it.each([undefined, "", "invalid", "2029-12-31T23:59:59.999Z", "2000-01-01T00:00:00Z"])("refuses missing, invalid or expired quote expiry %j", (expiresAt) => {
    const body = answer({ expiresAt: 9_999_999_999 });
    body.paymentQuote!.expiresAt = expiresAt;
    expect(() => normalizeTokenQuote(token, body, now)).toThrow(/expiry/);
  });

  it.each(["0", "-1", "8.426", "1e6", "1".repeat(79)])("refuses an invalid token amount %s", (amount) => {
    const body = answer();
    body.paymentQuote!.payment.amount = amount;
    expect(() => normalizeTokenQuote(token, body, now)).toThrow(/whole amount/);
  });

  it("refuses a quote for another option or unit", () => {
    expect(() => normalizeTokenQuote(token, answer({ paymentOption: "another" }), now)).toThrow(/another/);
    const body = answer();
    body.paymentQuote!.payment.unit = "msat";
    expect(() => normalizeTokenQuote(token, body, now)).toThrow(/USDT/);
  });
});

describe("tokenOptionAccepts", () => {
  it("bounds an amount by the option's own limits, else the payRequest's", () => {
    const bounded = { ...token, minSendable: 5_000_000, maxSendable: 20_000_000 };
    expect([4_999, 5_000, 20_000, 20_001].map((sats) => tokenOptionAccepts(bounded, payRequest, sats))).toEqual([false, true, true, false]);
    expect([100_000, 100_001].map((sats) => tokenOptionAccepts(token, payRequest, sats))).toEqual([true, false]);
  });
});

describe("requestTokenQuote", () => {
  const client = (result: InvoiceResult) => ({ requestInvoice: async () => result });

  it("asks for the option and returns its normalized quote", async () => {
    await expect(requestTokenQuote(payRequest, token, 10_000, { client: client(answer()) }))
      .resolves.toMatchObject({ optionId: "usdt", destination: DEPOSIT, baseUnits: "8426000", amount: "8.426" });
  });

  it("refuses an answer with nothing to pay, and a quote expiring sooner than the caller allows", async () => {
    await expect(requestTokenQuote(payRequest, token, 10_000, { client: client({ kind: "bolt11", pr: "lnbc1" } as InvoiceResult) }))
      .rejects.toThrow(/nothing payable/);
    const soon = answer();
    soon.paymentQuote!.expiresAt = new Date(Date.now() + 30_000).toISOString();
    await expect(requestTokenQuote(payRequest, token, 10_000, { client: client(soon), minLifetimeMs: 60_000 }))
      .rejects.toThrow(/expires too soon/);
  });
});
