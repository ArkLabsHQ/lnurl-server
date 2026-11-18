import { ArkAddress, ConditionWitness, CSVMultisigTapscript, getArkPsbtFields, MultisigTapscript, SingleKey, Transaction, VtxoScript } from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { InMemorySwapStorage, StrictVhtlcScript, type EvmToArkadeSwapResponse } from "@satora/swap";
import { base64, hex } from "@scure/base";
import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimSatoraSwap, continueSatoraClaim, fundSatoraSwap, SATORA_POLYGON_USDC, type SatoraIntent } from "../src/rails/satora-sdk.js";

const sdk = vi.hoisted(() => ({
  getEvmAddress: vi.fn(),
  getStoredSwap: vi.fn(),
  getSwap: vi.fn(),
  fundSwapGasless: vi.fn(),
}));
const readContract = vi.hoisted(() => vi.fn());
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
  createPublicClient: () => ({ readContract }),
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
    source_token: { chain: "137", token_id: SATORA_POLYGON_USDC, decimals: 6, name: "USD Coin", symbol: "USDC" },
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

describe("Satora's server signer", () => {
  it("submits only after both balances match and the caller reserves submission", async () => {
    const reserve = vi.fn(async () => {});
    await expect(fundSatoraSwap(intent, reserve)).resolves.toBe(txHash);
    expect(readContract.mock.calls.map(([opts]) => opts.blockTag)).toEqual(["finalized", "latest"]);
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(sdk.fundSwapGasless.mock.invocationCallOrder[0]);
    expect(sdk.fundSwapGasless).toHaveBeenCalledWith(intent.swapId, { funding: { maxSourceAmount: deposit } });
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
