import { describe, expect, it, vi } from "vitest";
import { arkadeAssetOptions, createLnurlClient, type PayRequest, type PaymentOption } from "../src/index.js";

const assetId = "ab".repeat(34);
const option: PaymentOption = {
  id: `arkade-asset:${assetId}`,
  type: "arkade-asset",
  assetId,
  caip19Id: `arkade:mutinynet/asset:${assetId}`,
  assetCallback: "https://pay.example/arkade-asset/alice",
  verifiable: true,
};
const lookup: PayRequest = {
  tag: "payRequest", callback: "https://pay.example/lnurl/callback", minSendable: 1000, maxSendable: 2000,
  metadata: "[]", paymentOptions: [option],
  source: { url: "https://pay.example/.well-known/lnurlp/alice", surface: "address" },
};
const amount = "18446744073709551615";
const payment = {
  paymentOption: option.id, paymentDestination: "tark1qxyz", assetId, assetAmount: amount, network: "mutinynet",
};
const reply = (body: Record<string, unknown>) => new Response(JSON.stringify({ status: "OK", ...body }));

describe("native Arkade asset payments", () => {
  it("discovers exact and unique asset options on the payRequest's origin", () => {
    expect(arkadeAssetOptions(lookup)).toEqual([{
      id: option.id, assetId, caip19Id: option.caip19Id, assetCallback: option.assetCallback, network: "mutinynet", verifiable: true,
    }]);
    for (const alternative of [
      { ...option, assetCallback: "https://lookalike.example/alice" },
      { ...option, assetCallback: "https://user:pass@pay.example/alice" },
      { ...option, caip19Id: `arkade:mutinynet/asset:${"cd".repeat(34)}` },
      { ...option, type: "arkade" },
      { ...option, available: false },
    ]) {
      expect(arkadeAssetOptions({ ...lookup, paymentOptions: [alternative] })).toEqual([]);
    }
    expect(arkadeAssetOptions({ ...lookup, paymentOptions: [option, option] })).toEqual([]);
  });

  it("sends an exact uint64 amount independently of the millisatoshi bounds", async () => {
    const fetchImpl = vi.fn(async () => reply(payment));
    const client = createLnurlClient({ fetchImpl });
    await expect(client.requestArkadeAssetPayment(lookup, { assetId, amount: BigInt(amount) })).resolves.toEqual(payment);
    expect(fetchImpl).toHaveBeenCalledWith(option.assetCallback, expect.objectContaining({
      method: "POST", redirect: "error", body: JSON.stringify({ assetId, amount }),
    }));
  });

  it("refuses malformed amounts, unadvertised assets and invoice fallback before posting", async () => {
    const fetchImpl = vi.fn(async () => reply(payment));
    const client = createLnurlClient({ fetchImpl });
    for (const amount of ["0", "1.0", "01", "1\n", "18446744073709551616"]) {
      await expect(client.requestArkadeAssetPayment(lookup, { assetId, amount })).rejects.toThrow(/positive uint64/);
    }
    await expect(client.requestArkadeAssetPayment(lookup, { assetId: "cd".repeat(34), amount })).rejects.toThrow(/does not offer/);
    await expect(client.requestInvoice(lookup, { paymentOption: option.id, amountSat: 1 })).rejects.toThrow(/atomic Arkade asset units/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed on a mismatched echoed asset, amount or network", async () => {
    for (const fields of [{ assetId: "cd".repeat(34) }, { assetAmount: "1" }, { network: "regtest" }]) {
      const client = createLnurlClient({ fetchImpl: async () => reply({ ...payment, ...fields }) });
      await expect(client.requestArkadeAssetPayment(lookup, { assetId, amount })).rejects.toThrow(/requested Arkade asset payment/);
    }
  });

  it("requires a same-origin receipt and checks the receipt against the issued terms", async () => {
    const verify = "https://pay.example/lnurl/verify/unique";
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const fetchImpl = vi.fn(async (url: string) => url === verify
      ? reply({ ...payment, assetAmount: "1", settled: true })
      : reply({ ...payment, verify, expiresAt }));
    const client = createLnurlClient({ fetchImpl });
    const issued = await client.requestArkadeAssetPayment(lookup, { assetId, amount, receipt: true });
    expect(issued).toEqual({ ...payment, verify, expiresAt });
    await expect(client.requestArkadeAssetPayment(lookup, { assetId, amount })).rejects.toThrow(/receipt terms for a direct/);
    await expect(client.pollVerify(verify, { expect: issued })).rejects.toThrow(/different payment/);
    expect(fetchImpl).toHaveBeenCalledWith(verify, expect.objectContaining({ redirect: "error" }));
    const crossed = createLnurlClient({ fetchImpl: async () => reply({ ...payment, verify: "https://other.example/verify", expiresAt }) });
    await expect(crossed.requestArkadeAssetPayment(lookup, { assetId, amount, receipt: true })).rejects.toThrow(/valid Arkade asset receipt/);
  });
});
