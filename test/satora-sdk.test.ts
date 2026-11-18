import { ArkAddress, ConditionWitness, CSVMultisigTapscript, getArkPsbtFields, MultisigTapscript, SingleKey, Transaction, VtxoScript } from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Asset, InMemorySwapStorage, PERMIT2_ADDRESS, StrictVhtlcScript, type EvmToArkadeSwapResponse } from "@satora/swap";
import { base64, hex } from "@scure/base";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, keccak256, parseAbiParameters, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { satoraSource } from "../src/rails/satora-catalogue.js";
import { claimSatoraSwap, continueSatoraClaim, createSatoraSwap, fundSatoraSwap, readSatoraRecoveryReceipt, readSatoraSwap, type SatoraIntent } from "../src/rails/satora-sdk.js";

const sdk = vi.hoisted(() => ({
  getEvmAddress: vi.fn(),
  getStoredSwap: vi.fn(),
  getEvmFundingExpectation: vi.fn(),
  getSwapDepositorKey: vi.fn(),
  getSwap: vi.fn(),
  createSwap: vi.fn(),
  fundSwapGasless: vi.fn(),
}));
const readContract = vi.hoisted(() => vi.fn());
const receiptFor = vi.hoisted(() => vi.fn());
const blockFor = vi.hoisted(() => vi.fn());
const prepare = vi.hoisted(() => vi.fn());
const rawSend = vi.hoisted(() => vi.fn());
const waitForReceipt = vi.hoisted(() => vi.fn());
const arkade = vi.hoisted(() => ({
  getVtxos: vi.fn(),
  getInfo: vi.fn(),
  submitTx: vi.fn(),
  finalizeTx: vi.fn(),
  getPendingTxs: vi.fn(),
}));

vi.mock("@satora/swap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@satora/swap")>()),
  Client: {
    builder() {
      const builder = {
        withMnemonic: () => builder,
        withBaseUrl: () => builder,
        withSignerStorage: () => builder,
        withSwapStorage: () => builder,
        withArkadeServerUrl: () => builder,
        withLogLevel: () => builder,
        build: async () => sdk,
      };
      return builder;
    },
  },
}));

vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: ({ chain }: { chain: { id: number } }) => ({
    readContract: (opts: unknown) => readContract(chain.id, opts),
    getTransactionReceipt: (opts: unknown) => receiptFor(chain.id, opts),
    getBlock: (opts: unknown) => blockFor(chain.id, opts),
    estimateFeesPerGas: async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 2n }),
    estimateGas: async () => 40_000n,
    getTransactionCount: async () => 0,
    waitForTransactionReceipt: (opts: unknown) => waitForReceipt(chain.id, opts),
  }),
  createWalletClient: ({ chain }: { chain: { id: number } }) => ({
    prepareTransactionRequest: (opts: unknown) => prepare(chain.id, opts),
    sendRawTransaction: (opts: unknown) => rawSend(chain.id, opts),
  }),
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@arkade-os/sdk")>()),
  RestArkProvider: class { constructor() { return arkade; } },
  RestIndexerProvider: class { constructor() { return arkade; } },
}));

const address = (fill: number) => getAddress(`0x${fill.toString(16).padStart(2, "0").repeat(20)}`);
function pubkey(fill: number): Uint8Array {
  return secp256k1.getPublicKey(new Uint8Array(32).fill(fill), true).subarray(1);
}

const operator = pubkey(21);
const receiver = pubkey(22);
const sender = pubkey(24);
const preimage = new Uint8Array(32).fill(31);
const preimageHash = sha256(preimage);
const seconds = (value: number) => ({ type: "seconds" as const, value: BigInt(value) });
const expiry = Math.floor(Date.now() / 1000) + 3600;
const vhtlc = new StrictVhtlcScript({
  receiver,
  sender,
  server: operator,
  preimageHash: ripemd160(preimageHash),
  refundLocktime: BigInt(expiry),
  unilateralClaimDelay: seconds(512),
  unilateralRefundDelay: seconds(1024),
  unilateralRefundWithoutReceiverDelay: seconds(2048),
});
const arkadeAddress = (fill: number) => new VtxoScript([
  MultisigTapscript.encode({ pubkeys: [pubkey(fill), operator] }).script,
]).address("ark", operator).encode();
const amountSat = 125_000;
const owner = address(25);
const txHash = `0x${"de".repeat(32)}`;
const deposit = 109_747_023n;
const polygonUsdc = getAddress(Asset.USDC_POLYGON.tokenId);

let intent: SatoraIntent;
let originalSwap: EvmToArkadeSwapResponse & { direction: "evm_to_arkade" };

beforeEach(() => {
  vi.resetAllMocks();
  intent = {
    swapId: "satora-test-id",
    amountSat,
    destination: arkadeAddress(23),
    mnemonic: "test-seed",
    storage: new InMemorySwapStorage(),
    source: {
      id: "satora-usdcpolygon", type: "eip155", chain: "137", token: polygonUsdc,
      asset: `eip155:137/erc20:${polygonUsdc}`, unit: "USDC", decimals: 6, mode: "direct", gas: "provider",
    },
  };
  originalSwap = {
    id: intent.swapId,
    direction: "evm_to_arkade",
    status: "pending",
    gasless: true,
    evm_chain_id: 137,
    evm_htlc_kind: "erc20",
    arkade_htlc_script_version: 1,
    arkade_server_pk: hex.encode(operator),
    btc_vhtlc_address: vhtlc.address("ark", operator).encode(),
    sender_pk: hex.encode(sender),
    vhtlc_refund_locktime: expiry,
    unilateral_claim_delay: 512,
    unilateral_refund_delay: 1024,
    unilateral_refund_without_receiver_delay: 2048,
    target_arkade_address: intent.destination,
    target_amount: String(amountSat),
    source_token: { chain: "137", token_id: polygonUsdc, decimals: 6, name: "USD Coin", symbol: "USDC" },
    target_token: { chain: "Arkade", token_id: "btc", decimals: 8, name: "Bitcoin", symbol: "BTC" },
    source_amount: String(deposit),
    created_at: new Date().toISOString(),
    client_evm_address: owner,
    hash_lock: hex.encode(preimageHash),
    evm_htlc_address: address(26),
    evm_coordinator_address: address(27),
    evm_refund_locktime: 1_900_000_000,
    server_evm_address: address(28),
    evm_expected_sats: String(amountSat),
    evm_funding_confirmations: 1,
    evm_htlc_version: 7,
    chain: "Arkade",
    network: "bitcoin",
    fee_sats: 50,
    receiver_pk: hex.encode(receiver),
  };
  sdk.getEvmAddress.mockReturnValue(owner);
  sdk.getStoredSwap.mockResolvedValue({
    swapId: intent.swapId, targetAddress: intent.destination, response: originalSwap,
    preimage: hex.encode(preimage), preimageHash: hex.encode(preimageHash),
    publicKey: hex.encode(receiver), secretKey: "16".repeat(32),
  });
  sdk.getSwap.mockResolvedValue({ ...originalSwap });
  sdk.fundSwapGasless.mockResolvedValue({ txHash });
  readContract.mockResolvedValue(deposit);
  arkade.getInfo.mockResolvedValue({
    checkpointTapscript: hex.encode(CSVMultisigTapscript.encode({
      timelock: { type: "blocks", value: 144n }, pubkeys: [operator],
    }).script),
  });
});
afterEach(() => vi.unstubAllGlobals());

function providerPreview(fee: bigint, permit: boolean) {
  const calls = fee ? [{
    target: polygonUsdc, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(originalSwap.server_evm_address), fee] }),
  }] : [];
  const callsHash = keccak256(encodeAbiParameters(parseAbiParameters("(address target, uint256 value, bytes data)[]"), [calls]));
  return {
    coordinator_address: originalSwap.evm_coordinator_address, permit2_address: PERMIT2_ADDRESS,
    source_token_address: polygonUsdc, source_amount: String(deposit), lock_token_address: polygonUsdc,
    preimage_hash: originalSwap.hash_lock, claim_address: originalSwap.server_evm_address,
    timelock: originalSwap.evm_refund_locktime, calls_hash: callsHash,
    calls: calls.map(({ target, value, data }) => ({ target, value: String(value), call_data: data })),
    relay_fee: String(fee),
    eip2612: { supported: permit, already_approved: false, domain_separator: `0x${"11".repeat(32)}`, nonce: 0 },
  };
}

function mockCreate() {
  const storage = vi.spyOn(intent.storage, "store");
  const terms = {
    chainId: 137, coordinator: originalSwap.evm_coordinator_address, htlcAddress: originalSwap.evm_htlc_address,
    claimAddress: originalSwap.server_evm_address, timelock: originalSwap.evm_refund_locktime,
    sourceToken: polygonUsdc, sourceAmount: String(deposit), lockToken: polygonUsdc,
  };
  const stored = { response: originalSwap, targetAddress: intent.destination, swapId: intent.swapId, evmFundingTerms: terms };
  sdk.getStoredSwap.mockResolvedValue(stored);
  sdk.createSwap.mockResolvedValue({ response: originalSwap });
  sdk.getEvmFundingExpectation.mockResolvedValue({ hashLock: originalSwap.hash_lock, terms });
  return storage;
}

describe("Satora's server signer", () => {
  it("pins a fee that fits the exact QR amount before issuing a direct deposit", async () => {
    const storage = mockCreate();
    const payload = providerPreview(250n, true);
    const fetch = vi.fn(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetch);
    await expect(createSatoraSwap(intent)).resolves.toMatchObject({ sourceAmount: String(deposit) });
    expect(storage).toHaveBeenCalledWith(expect.objectContaining({ lnurlSatoraRelayFee: "250" }));
    expect(fetch.mock.calls).toHaveLength(1);
    const saved = storage.mock.calls[0][0];
    sdk.getStoredSwap.mockResolvedValue(saved);
    await expect(fundSatoraSwap(intent)).resolves.toBe(txHash);
    expect(sdk.fundSwapGasless).toHaveBeenCalledWith(intent.swapId, { funding: { maxSourceAmount: deposit, maxRelayFee: 250n } });
  });

  it("fails closed when Satora cannot approve the deposit or alters the quoted funding", async () => {
    mockCreate();
    readContract.mockResolvedValue(0n);
    const fetch = vi.fn(async () => Response.json(providerPreview(0n, false)));
    vi.stubGlobal("fetch", fetch);
    await expect(createSatoraSwap(intent)).rejects.toThrow("verify the quoted deposit funding terms");
    fetch.mockResolvedValueOnce(Response.json({ ...providerPreview(250n, true), source_amount: String(deposit + 1n) }));
    await expect(createSatoraSwap(intent)).rejects.toThrow("verify the quoted deposit funding terms");
    await expect(intent.storage.get(intent.swapId)).resolves.toBeNull();
  });

  it("sponsors and approves exactly Ethereum USDT before reserving the one funding relay", async () => {
    const key = `0x${"13".repeat(32)}` as Hex;
    const owner = privateKeyToAccount(key).address;
    const token = Asset.USDT_ETHEREUM.tokenId;
    intent.source = { ...intent.source, chain: "1", token, unit: "USDT", gas: "native", asset: `eip155:1/erc20:${token}` };
    const ensureGas = vi.fn(async () => {});
    intent.ensureGas = ensureGas;
    originalSwap.evm_chain_id = 1;
    originalSwap.source_token = { ...originalSwap.source_token, chain: "1", token_id: token, symbol: "USDT" };
    originalSwap.client_evm_address = owner;
    sdk.getEvmAddress.mockReturnValue(owner);
    sdk.getSwap.mockResolvedValue({ ...originalSwap });
    sdk.getSwapDepositorKey.mockResolvedValue({ privateKey: key });
    let allowance = 0n;
    readContract.mockImplementation(async (_chain, opts) => opts.functionName === "allowance" ? allowance : deposit);
    prepare.mockImplementation(async (chain, opts) => ({ ...opts, chainId: chain, type: "eip1559" }));
    rawSend.mockImplementation(async (_chain, { serializedTransaction }) => {
      allowance = deposit;
      return keccak256(serializedTransaction);
    });
    waitForReceipt.mockResolvedValue({ status: "success" });
    const reserve = vi.fn(async () => {});
    await expect(fundSatoraSwap(intent, reserve)).resolves.toBe(txHash);
    expect(ensureGas).toHaveBeenCalledWith({ swapId: intent.swapId, source: intent.source, depositAddress: owner, minimumWei: 400_000n });
    const [chain, { serializedTransaction }] = rawSend.mock.calls[0];
    expect(chain).toBe(1);
    const signed = parseTransaction(serializedTransaction);
    expect(signed.to?.toLowerCase()).toBe(token.toLowerCase());
    expect(decodeFunctionData({ abi: erc20Abi, data: signed.data! })).toEqual({ functionName: "approve", args: [PERMIT2_ADDRESS, deposit] });
    expect(rawSend.mock.invocationCallOrder[0]).toBeLessThan(reserve.mock.invocationCallOrder[0]);
  });

  it("submits only after both balances match and the caller reserves submission", async () => {
    const reserve = vi.fn(async () => {});
    await expect(fundSatoraSwap(intent, reserve)).resolves.toBe(txHash);
    expect(readContract.mock.calls.map(([chain, opts]) => [chain, opts.address, opts.blockTag])).toEqual([
      [137, polygonUsdc, "finalized"], [137, polygonUsdc, "latest"],
    ]);
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(sdk.fundSwapGasless.mock.invocationCallOrder[0]);
    expect(sdk.fundSwapGasless).toHaveBeenCalledWith(intent.swapId, { funding: { maxSourceAmount: deposit, maxRelayFee: 0n } });
  });

  it.each([
    ["1", Asset.USDC_ETHEREUM.tokenId],
    ["42161", Asset.USDC_ARBITRUM.tokenId],
  ] as const)("uses the pinned token and source chain %s for funding and recovery", async (chain, token) => {
    intent.source = {
      ...intent.source, id: `satora-usdc-${chain}`, chain, token, asset: `eip155:${chain}/erc20:${token}`,
    };
    originalSwap.evm_chain_id = Number(chain);
    originalSwap.source_token = { ...originalSwap.source_token, chain, token_id: token };
    sdk.getSwap.mockResolvedValue({ ...originalSwap });
    await expect(fundSatoraSwap(intent)).resolves.toBe(txHash);
    expect(readContract.mock.calls.map(([id, opts]) => [id, opts.address, opts.blockTag])).toEqual([
      [Number(chain), token, "safe"], [Number(chain), token, "latest"],
    ]);

    receiptFor.mockResolvedValue({ status: "success", blockNumber: 2n });
    blockFor.mockResolvedValue({ number: 1n });
    await expect(readSatoraRecoveryReceipt(txHash, intent.source)).resolves.toBeNull();
    blockFor.mockResolvedValue({ number: 2n });
    await expect(readSatoraRecoveryReceipt(txHash, intent.source)).resolves.toBe("success");
    expect(receiptFor).toHaveBeenCalledWith(Number(chain), { hash: txHash });
    expect(blockFor).toHaveBeenCalledWith(Number(chain), { blockTag: "finalized" });
  });

  it("rejects provider source chain, contract or decimal substitution before any deposit lookup", async () => {
    sdk.getSwap.mockResolvedValue({ ...originalSwap, evm_chain_id: 1 });
    await expect(fundSatoraSwap(intent)).rejects.toThrow("returned a different payment");
    sdk.getSwap.mockResolvedValue({ ...originalSwap, source_token: { ...originalSwap.source_token, token_id: address(19) } });
    await expect(fundSatoraSwap(intent)).rejects.toThrow("returned a different payment");
    sdk.getSwap.mockResolvedValue({ ...originalSwap, source_token: { ...originalSwap.source_token, decimals: 18 } });
    await expect(fundSatoraSwap(intent)).rejects.toThrow("returned a different payment");
    expect(readContract).not.toHaveBeenCalled();
    expect(sdk.fundSwapGasless).not.toHaveBeenCalled();
  });

  it("pins the bridge source separately from the Arbitrum lock and reports the source burn", async () => {
    intent.source = satoraSource("satora-usdcbase")!;
    const hubToken = Asset.USDC_ARBITRUM.tokenId;
    const hubTx = `0x${"fa".repeat(32)}`;
    originalSwap.evm_chain_id = 42161;
    originalSwap.source_token = { ...originalSwap.source_token, chain: "42161", token_id: hubToken };
    originalSwap.bridge_source_chain = "Base";
    originalSwap.bridge_source_token_address = intent.source.token;
    originalSwap.evm_fund_txid = hubTx;
    sdk.getStoredSwap.mockResolvedValue({ swapId: intent.swapId, targetAddress: intent.destination, response: originalSwap, cctpBurnTxid: txHash });
    sdk.getSwap.mockResolvedValue({ ...originalSwap });
    await expect(readSatoraSwap(intent)).resolves.toMatchObject({ fundingTxId: txHash, depositAddress: owner });

    sdk.getSwap.mockResolvedValue({ ...originalSwap, bridge_source_chain: "Optimism" });
    await expect(readSatoraSwap(intent)).rejects.toThrow("returned a different payment");
    sdk.getSwap.mockResolvedValue({ ...originalSwap, bridge_source_token_address: polygonUsdc });
    await expect(readSatoraSwap(intent)).rejects.toThrow("returned a different payment");
    receiptFor.mockResolvedValue({ status: "success", blockNumber: 2n });
    blockFor.mockResolvedValue({ number: 2n });
    await expect(readSatoraRecoveryReceipt(hubTx, intent.source, true)).resolves.toBe("success");
    expect(receiptFor).toHaveBeenCalledWith(42161, { hash: hubTx });
  });

  it("keeps a reorg or racing overpayment out of the relay", async () => {
    readContract.mockResolvedValueOnce(deposit).mockResolvedValueOnce(deposit + 1n);
    const reserve = vi.fn(async () => {});
    await expect(fundSatoraSwap(intent, reserve)).rejects.toThrow("must match");
    expect(reserve).not.toHaveBeenCalled();
    expect(sdk.fundSwapGasless).not.toHaveBeenCalled();
  });

  it("does not relay after losing the persistent fence", async () => {
    const reserve = vi.fn(async () => { throw new Error("already reserved"); });
    await expect(fundSatoraSwap(intent, reserve)).rejects.toThrow("already reserved");
    expect(sdk.fundSwapGasless).not.toHaveBeenCalled();
  });

  it("detects provider payout or lockup substitution before revealing the preimage", async () => {
    sdk.getSwap.mockResolvedValue({ ...originalSwap, status: "serverfunded", btc_vhtlc_address: arkadeAddress(24) });
    await expect(claimSatoraSwap(intent)).rejects.toThrow("changed the existing payment quote");
    sdk.getSwap.mockResolvedValue({ ...originalSwap, status: "serverfunded", target_arkade_address: arkadeAddress(24) });
    await expect(claimSatoraSwap(intent)).rejects.toThrow("returned a different payment");
    expect(arkade.getVtxos).not.toHaveBeenCalled();
    expect(arkade.submitTx).not.toHaveBeenCalled();
  });

  it("claims fresh sufficient funding to the recorded destination only", async () => {
    sdk.getSwap.mockResolvedValue({ ...originalSwap, status: "serverfunded" });
    const txid = "12".repeat(32);
    arkade.getVtxos.mockResolvedValueOnce({ vtxos: [{ txid, vout: 0, value: amountSat - 1 }] });
    await expect(claimSatoraSwap(intent)).rejects.toThrow("does not cover");
    expect(arkade.submitTx).not.toHaveBeenCalled();
    arkade.getVtxos.mockResolvedValue({ vtxos: [{ txid, vout: 0, value: amountSat }] });
    const server = SingleKey.fromHex("15".repeat(32));
    arkade.submitTx.mockImplementation(async (signed: string, checkpoints: string[]) => {
      const tx = Transaction.fromPSBT(base64.decode(signed));
      const finalArkTx = base64.encode((await server.sign(tx)).toPSBT());
      const signedCheckpointTxs = await Promise.all(checkpoints.map(async (checkpoint) =>
        base64.encode((await server.sign(Transaction.fromPSBT(base64.decode(checkpoint)))).toPSBT())));
      return { arkTxid: tx.id, finalArkTx, signedCheckpointTxs };
    });
    const remember = vi.fn(async () => {});
    const candidate = await claimSatoraSwap(intent, remember);
    expect(remember).toHaveBeenCalledWith(candidate);
    expect(remember.mock.invocationCallOrder[0]).toBeLessThan(arkade.submitTx.mock.invocationCallOrder[0]);
    const submitted = Transaction.fromPSBT(base64.decode(arkade.submitTx.mock.calls[0][0]));
    expect(submitted.getOutput(0)).toMatchObject({ script: ArkAddress.decode(intent.destination).pkScript, amount: BigInt(amountSat) });
    expect(arkade.getVtxos).toHaveBeenCalledTimes(2);

    await expect(continueSatoraClaim(intent, candidate)).resolves.toBe(candidate);
    await expect(continueSatoraClaim(intent, "34".repeat(32))).rejects.toThrow();
    expect(arkade.submitTx).toHaveBeenCalledTimes(2);
    expect(arkade.getPendingTxs).not.toHaveBeenCalled();

    const pending = await arkade.submitTx.mock.results[0].value;
    arkade.getVtxos.mockResolvedValue({ vtxos: [{
      txid, vout: 0, value: amountSat, isSpent: true, spentBy: "56".repeat(32), arkTxId: candidate,
    }] });
    arkade.getPendingTxs.mockResolvedValueOnce([{ ...pending, arkTxid: "34".repeat(32) }]);
    const previousFinalizations = arkade.finalizeTx.mock.calls.length;
    await expect(continueSatoraClaim(intent, candidate)).rejects.toThrow("Could not finalize");
    expect(arkade.finalizeTx).toHaveBeenCalledTimes(previousFinalizations);
    arkade.getPendingTxs.mockResolvedValueOnce([pending]);
    await expect(continueSatoraClaim(intent, candidate)).resolves.toBe(candidate);
    expect(arkade.finalizeTx).toHaveBeenCalledTimes(previousFinalizations + 1);
    expect(arkade.submitTx).toHaveBeenCalledTimes(2);
    const proof = Transaction.fromPSBT(base64.decode(arkade.getPendingTxs.mock.calls[1][0].proof));
    for (let input = 0; input < proof.inputsLength; input++) {
      expect(proof.getInput(input).tapScriptSig).toHaveLength(1);
      expect(getArkPsbtFields(proof, input, ConditionWitness)).toEqual([[preimage]]);
    }
  });
});
