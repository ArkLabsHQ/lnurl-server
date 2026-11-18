import { beforeEach, describe, expect, it, vi } from "vitest";
import { cctpMetaForChainId, finalityForChainId, TOKEN_MESSENGER_V2, type Client, type EvmSigner } from "@satora/swap";
import {
  encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, getAddress, keccak256, parseAbi,
  TransactionReceiptNotFoundError, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  canRecoverUnburnedSatoraCctp, cctpEvmSource, fundSatoraCctp, hasFinalizedSatoraCctpRecovery, recoverSatoraCctp,
  resumeSatoraCctp, validateSatoraCctpBurn, type SatoraCctpBurn,
} from "../src/rails/satora-cctp.js";
import type { SatoraSource } from "../src/rails/satora-catalogue.js";
import type { SatoraIntent } from "../src/rails/satora-sdk.js";

const rpc = vi.hoisted(() => ({
  readContract: vi.fn(),
  getTransactionCount: vi.fn(),
  estimateFeesPerGas: vi.fn(),
  estimateGas: vi.fn(),
  getBlock: vi.fn(),
  getTransactionReceipt: vi.fn(),
  sendRawTransaction: vi.fn(),
}));
vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createPublicClient: vi.fn(() => rpc),
  createWalletClient: vi.fn(() => rpc),
}));
vi.mock("@satora/swap", async (importOriginal) => ({
  ...await importOriginal<typeof import("@satora/swap")>(),
  fetchCctpFee: vi.fn(async () => ({ minimumFee: 0.2 })),
}));

const key = `0x${"1".padStart(64, "0")}` as Hex;
const account = privateKeyToAccount(key);
const token = getAddress(cctpMetaForChainId(8453).usdc);
const messenger = getAddress(TOKEN_MESSENGER_V2);
const amount = 5_000_000n;
const hubDomain = cctpMetaForChainId(42161).domain;
const hubToken = getAddress(cctpMetaForChainId(42161).usdc);
const sourceDomain = cctpMetaForChainId(8453).domain;
const source: SatoraSource = {
  id: "satora-usdcbase", type: "eip155", chain: "8453", token, asset: `eip155:8453/erc20:${token}`,
  unit: "USDC", decimals: 6, mode: "cctp", gas: "native",
};
const burnAbi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external",
]);

function burnData(owner: Address = account.address, destinationDomain = hubDomain, burnAmount = amount) {
  const recipient = `0x${owner.toLowerCase().slice(2).padStart(64, "0")}` as Hex;
  return encodeFunctionData({
    abi: burnAbi, functionName: "depositForBurn",
    args: [burnAmount, destinationDomain, recipient, token, recipient, 10_000n, finalityForChainId(8453)],
  });
}

async function candidate(data = burnData(), chainId = 8453): Promise<SatoraCctpBurn> {
  const raw = await account.signTransaction({
    type: "eip1559", chainId, nonce: 0, to: messenger, data, gas: 150_000n,
    maxFeePerGas: 1n, maxPriorityFeePerGas: 0n,
  });
  return { raw, hash: keccak256(raw) };
}

beforeEach(() => {
  vi.resetAllMocks();
  rpc.readContract.mockImplementation(async ({ functionName }) => functionName === "usedNonces" ? 0n : amount);
  rpc.getTransactionCount.mockResolvedValue(0);
  rpc.estimateFeesPerGas.mockResolvedValue({ maxFeePerGas: 5n, maxPriorityFeePerGas: 1n });
  rpc.estimateGas.mockResolvedValue(100_000n);
  rpc.getBlock.mockResolvedValue({ number: 2n });
  rpc.sendRawTransaction.mockImplementation(async ({ serializedTransaction }: { serializedTransaction: Hex }) => keccak256(serializedTransaction));
});

function fixture() {
  const store = vi.fn();
  const intent = {
    swapId: "swap", source, ensureGas: vi.fn(), storage: { store },
  } as unknown as SatoraIntent;
  const fundSwap = vi.fn(async (_: string, signer: EvmSigner) => ({
    cctp: { burnTxHash: await signer.sendTransaction({ to: messenger, data: burnData() }) },
  }));
  const sweepTxHash = `0x${"3".repeat(64)}` as Hex;
  const recover = vi.fn(async () => ({ sweepTxHash }));
  const attestation = [
    "00000001", sourceDomain.toString(16).padStart(8, "0"), hubDomain.toString(16).padStart(8, "0"),
    "a".repeat(192), account.address.slice(2).toLowerCase().padStart(64, "0"), "0".repeat(16),
  ].join("");
  const client = {
    getSwapDepositorKey: async () => ({ privateKey: key }),
    getEvmAddress: () => account.address,
    getStoredSwap: vi.fn(async () => ({ swapId: "swap" })),
    cctpInbound: { waitForAttestation: vi.fn(async () => ({ message: `0x${attestation}` })) },
    fundSwap,
    recoverCctpInboundSwap: recover,
  } as unknown as Client;
  return { client, intent, amount, fundSwap, store, recover, sweepTxHash };
}

describe("Satora EVM CCTP source", () => {
  it("uses native USDC and pins the domain, debit, signer and recipient of a saved burn", async () => {
    expect(cctpEvmSource(source)).toMatchObject({ name: "Base", token, hubToken: getAddress(cctpMetaForChainId(42161).usdc) });
    expect(() => cctpEvmSource({ ...source, token: account.address })).toThrow(/source token/);
    await expect(validateSatoraCctpBurn(await candidate(), source, account.address, amount)).resolves.toHaveProperty("hash");
    await expect(validateSatoraCctpBurn(await candidate(burnData(), 10), source, account.address, amount)).rejects.toThrow(/chain or owner/);
    await expect(validateSatoraCctpBurn(await candidate(burnData(account.address, 0)), source, account.address, amount)).rejects.toThrow(/changed its payment terms/);
    await expect(validateSatoraCctpBurn(await candidate(burnData(account.address, hubDomain, amount + 1n)), source, account.address, amount))
      .rejects.toThrow(/changed its payment terms/);
  });

  it("requires exact balances and writes the signed candidate before dispatch", async () => {
    const f = fixture();
    const beforeBurn = vi.fn(async (_hash, burn) => {
      expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
      await validateSatoraCctpBurn(burn, source, account.address, amount);
    });
    const hash = await fundSatoraCctp({ ...f, beforeBurn });
    expect(f.intent.ensureGas).toHaveBeenCalledOnce();
    expect(beforeBurn).toHaveBeenCalledWith(hash, { hash, raw: expect.any(String) });
    expect(rpc.sendRawTransaction).toHaveBeenCalledOnce();

    rpc.readContract.mockResolvedValue(amount + 1n);
    await expect(fundSatoraCctp({ ...f, beforeBurn })).rejects.toThrow(/does not match/);
    expect(rpc.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("resumes an ambiguous source dispatch with identical bytes and never builds another burn", async () => {
    const f = fixture();
    const burn = await candidate();
    const intent = { ...f.intent, cctpBurn: burn };
    rpc.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: burn.hash as Hex }));
    await expect(resumeSatoraCctp({ ...f, intent })).resolves.toBeUndefined();
    expect(f.fundSwap).not.toHaveBeenCalled();
    expect(rpc.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: burn.raw });

    rpc.getTransactionReceipt.mockResolvedValue({ status: "success", transactionHash: burn.hash });
    f.fundSwap.mockImplementationOnce(async (_id, signer) => {
      await expect(signer.sendTransaction({ to: messenger, data: burnData() })).rejects.toThrow(/New CCTP source transaction is disabled/);
      return { cctp: { burnTxHash: burn.hash } };
    });
    await expect(resumeSatoraCctp({ ...f, intent })).resolves.toBe(burn.hash);
    expect(rpc.sendRawTransaction).toHaveBeenCalledOnce();
    expect(f.store).toHaveBeenCalledWith({ swapId: "swap", cctpBurnTxid: burn.hash });
  });

  it("observes the consumed Circle nonce before submitting another settlement", async () => {
    const f = fixture();
    const burn = await candidate();
    rpc.getTransactionReceipt.mockResolvedValue({ status: "success", transactionHash: burn.hash });
    rpc.readContract.mockResolvedValue(1n);
    await expect(resumeSatoraCctp({ ...f, intent: { ...f.intent, cctpBurn: burn } })).resolves.toBe(burn.hash);
    expect(f.fundSwap).not.toHaveBeenCalled();
  });

  it("recovers a confirmed source burn to the bound Arbitrum recipient after reserving recovery", async () => {
    const f = fixture();
    const burn = await candidate();
    const intent = { ...f.intent, cctpBurn: burn };
    const recipient = `0x${"2".repeat(40)}`;
    const beforeSubmit = vi.fn(async () => { expect(f.recover).not.toHaveBeenCalled(); });
    rpc.getTransactionReceipt.mockResolvedValue({ status: "reverted", transactionHash: burn.hash });
    await expect(recoverSatoraCctp({ ...f, intent, recipient, beforeSubmit })).rejects.toThrow(/not been confirmed/);
    expect(beforeSubmit).not.toHaveBeenCalled();
    rpc.getTransactionReceipt.mockResolvedValue({ status: "success", transactionHash: burn.hash });
    await expect(recoverSatoraCctp({ ...f, intent, recipient, beforeSubmit })).resolves.toBe(f.sweepTxHash);
    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(f.recover).toHaveBeenCalledWith(intent.swapId, recipient, expect.objectContaining({ burnTxHash: burn.hash }));
  });

  it("only treats a finalized reverted burn with remaining source funds as recoverable", async () => {
    const f = fixture();
    const burn = await candidate();
    const intent = { ...f.intent, cctpBurn: burn };
    rpc.getTransactionReceipt.mockResolvedValue({ status: "reverted", transactionHash: burn.hash, blockNumber: 3n });
    await expect(canRecoverUnburnedSatoraCctp({ ...f, intent })).resolves.toBe(false);
    rpc.getBlock.mockResolvedValue({ number: 3n });
    await expect(canRecoverUnburnedSatoraCctp({ ...f, intent })).resolves.toBe(true);
    rpc.readContract.mockResolvedValue(0n);
    await expect(canRecoverUnburnedSatoraCctp({ ...f, intent })).resolves.toBe(false);
  });

  it("resumes a recovery only for minted USDC that still belongs to the order", async () => {
    const f = fixture();
    const burn = await candidate();
    const intent = { ...f.intent, cctpBurn: burn, retryBridgeRecovery: true as const };
    const recipient = `0x${"2".repeat(40)}`;
    const beforeSubmit = vi.fn(async () => undefined);
    rpc.getTransactionReceipt.mockResolvedValue({ status: "success", transactionHash: burn.hash });
    const retry = () => recoverSatoraCctp({ ...f, intent, recipient, beforeSubmit });
    await expect(retry()).rejects.toThrow(/has not minted/);
    rpc.readContract.mockImplementation(async ({ functionName }) => functionName === "usedNonces" ? 1n : 0n);
    await expect(retry()).rejects.toThrow(/No Arbitrum USDC remains/);
    expect(beforeSubmit).not.toHaveBeenCalled();
    rpc.readContract.mockImplementation(async ({ functionName }) => functionName === "usedNonces" ? 1n : amount);
    await expect(retry()).resolves.toBe(f.sweepTxHash);
    expect(beforeSubmit).toHaveBeenCalledOnce();
  });

  it("confirms a previously sent Arbitrum recovery only for the finalized USDC transfer to the bound recipient", async () => {
    const f = fixture();
    const recipient = `0x${"2".repeat(40)}` as Address;
    const logs = [{
      address: hubToken,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: account.address, to: recipient } }),
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    }];
    rpc.getTransactionReceipt.mockResolvedValue({
      status: "success", transactionHash: f.sweepTxHash, blockNumber: 3n, logs,
    });
    await expect(hasFinalizedSatoraCctpRecovery(f.client, f.sweepTxHash, recipient)).resolves.toBe(false);
    rpc.getBlock.mockResolvedValue({ number: 3n });
    await expect(hasFinalizedSatoraCctpRecovery(f.client, f.sweepTxHash, recipient)).resolves.toBe(true);
    await expect(hasFinalizedSatoraCctpRecovery(f.client, f.sweepTxHash, `0x${"3".repeat(40)}`)).resolves.toBe(false);
  });
});
