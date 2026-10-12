import { afterEach, describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import {
  arkade, ArkAddress, Batch, ConditionWitness, Extension, Intent, MultisigTapscript, networks, SingleKey, Transaction, VtxoScript, getArkPsbtFields,
  type ArkProvider, type Contract, type EmulatorProvider, type ExtendedVirtualCoin,
  SettlementEventType, type IndexerProvider, type IntentFeeConfig, type SettlementEvent, type VirtualCoin, type Wallet,
} from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Address } from "@scure/btc-signer";
import { covenantDestinationHandler, COVENANT_CONTRACT_TYPE } from "../src/covenant/contract.js";
import { compileCovenantV3 } from "../src/covenant/program.js";
import { createCovenantRenewer } from "../src/covenant/renewal.js";

vi.mock("@arkade-os/sdk", async (original) => {
  const sdk = await original<typeof import("@arkade-os/sdk")>();
  return { ...sdk, arkade: { ...sdk.arkade, createArkadeBatchHandler: vi.fn(sdk.arkade.createArkadeBatchHandler) } };
});

const key = (n: number) => secp256k1.getPublicKey(new Uint8Array(32).fill(n), true);
const params = {
  staticAddress: new VtxoScript([MultisigTapscript.encode({ pubkeys: [key(9).subarray(1), key(3).subarray(1)] }).script])
    .address("tark", key(3).subarray(1)).encode(),
  userPubkey: key(4).subarray(1), serverPubkey: key(3).subarray(1), emulatorPubkey: key(5),
  preimage: new Uint8Array(32).fill(7), recoveryDelaySeconds: 4096, version: 3,
};
const compiled = compileCovenantV3(params);
const contract: Contract = {
  type: COVENANT_CONTRACT_TYPE, params: covenantDestinationHandler.serializeParams(params),
  script: hex.encode(compiled.pkScript), address: compiled.address("tark", params.serverPubkey).encode(),
  state: "active", createdAt: 1,
};
const previous = (script: Uint8Array, value: number, n = 1) => {
  const tx = new Transaction();
  tx.addInput({ txid: hex.encode(new Uint8Array(32).fill(n)), index: 0 });
  tx.addOutput({ script, amount: BigInt(value) });
  return tx;
};
const prev = previous(compiled.pkScript, 1000);
const coin: VirtualCoin = {
  txid: prev.id, vout: 0, value: 1000, script: contract.script,
  createdAt: new Date(1000), status: { confirmed: true }, isUnrolled: false,
  isSwept: false, isSpent: false, expiresAt: new Date(Date.now() + 60_000), commitmentTxIds: ["cc".repeat(32)],
};

function setup(fresh: VirtualCoin = coin, fees: IntentFeeConfig = {}, sponsor?: Wallet, timeoutMs = 1000, maxTxInputs = 128) {
  const order: string[] = [];
  const returned = vi.fn();
  const indexer = {
    getVtxos: vi.fn(async () => ({ vtxos: [fresh] })),
    getVirtualTxs: vi.fn(async () => ({ txs: [base64.encode(prev.toPSBT())] })),
  };
  const emulator = {
    submitIntent: vi.fn(async (intent: { proof: string; message: Intent.Message }) => intent.proof),
    submitFinalization: vi.fn(async () => ({ signedForfeits: [] as string[], signedCommitmentTx: null })),
  };
  const arkProvider = {
    getInfo: vi.fn(async () => ({
      fees: { intentFee: fees }, dust: 330n, maxTxInputs,
      forfeitAddress: Address(networks.regtest).encode({ type: "tr", pubkey: params.serverPubkey }),
    })),
    registerIntent: vi.fn(async (_intent: { proof: string; message: Intent.RegisterMessage }) => { order.push("register"); return "intent"; }),
    deleteIntent: vi.fn(async (_intent: { proof: string; message: Intent.DeleteMessage }) => {}),
    getEventStream: vi.fn((_signal: AbortSignal, _topics: string[]): AsyncIterableIterator<SettlementEvent> => {
      order.push("stream"); return (async function* () {
        order.push("prime");
        try { yield { type: SettlementEventType.StreamStarted, id: "stream" }; } finally { returned(); }
      })();
    }),
    submitSignedForfeitTxs: vi.fn(async () => {}),
  };
  const join = vi.spyOn(Batch, "join").mockResolvedValue("dd".repeat(32));
  const handler = vi.mocked(arkade.createArkadeBatchHandler);
  handler.mockClear();
  const options = {
    arkProvider: arkProvider as unknown as ArkProvider, indexer: indexer as unknown as IndexerProvider,
    emulator: emulator as unknown as EmulatorProvider, network: networks.regtest, feePayer: sponsor, timeoutMs,
  };
  return { ...createCovenantRenewer(options), options, indexer, emulator, arkProvider, join, handler, order, returned };
}

async function payer(value = 1000) {
  const identity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(8));
  const script = new VtxoScript([MultisigTapscript.encode({ pubkeys: [await identity.xOnlyPublicKey(), params.serverPubkey] }).script]);
  const tx = previous(script.pkScript, value, 2);
  const input: ExtendedVirtualCoin = {
    ...coin, txid: tx.id, value, script: hex.encode(script.pkScript), assets: [],
    tapTree: script.encode(), intentTapLeafScript: script.leaves[0]!, forfeitTapLeafScript: script.leaves[0]!,
  };
  const wallet = {
    identity, getAddress: vi.fn(async () => script.address("tark", params.serverPubkey).encode()),
    getSpendableVtxos: vi.fn(async () => [input]),
  };
  return { wallet: wallet as unknown as Wallet, getSpendableVtxos: wallet.getSpendableVtxos, input, tx, identity };
}

afterEach(() => vi.restoreAllMocks());

describe("permissionless covenant renewal", () => {
  it("registers the named renewal leaf and rejoins a batch at full value", async () => {
    const env = setup();
    expect(await env.renew(contract, coin)).toBe("dd".repeat(32));
    const intent = env.emulator.submitIntent.mock.calls[0]![0];
    const proof = Transaction.fromPSBT(base64.decode(intent.proof));
    expect(proof.inputsLength).toBe(2);
    expect(proof.getInput(1).tapLeafScript).toEqual([compiled.functionByName("renew")!.tapLeafScript]);
    expect(proof.getOutput(0)).toMatchObject({ script: compiled.pkScript, amount: 1000n });
    expect(Intent.fee(proof)).toBe(0);
    expect(Extension.fromTx(proof).getEmulatorPacket()!.entries).toEqual([
      { vin: 1, script: compiled.functionByName("renew")!.arkadeScript, witness: new Uint8Array() },
    ]);
    expect(env.indexer.getVtxos).toHaveBeenCalledWith({ outpoints: [{ txid: coin.txid, vout: 0 }] });
    expect(env.order).toEqual(["stream", "prime", "register"]);
    expect(env.arkProvider.getEventStream.mock.calls[0]![1]).toEqual([
      env.handler.mock.calls[0]![4].cosigners_public_keys[0], `${coin.txid}:${coin.vout}`,
    ]);
    const [,,signer,,,session] = env.handler.mock.calls[0]!;
    expect(signer.signerSession()).toBe(session);
    expect(await signer.sign(proof, [1])).toBe(proof);
    expect(env.handler.mock.calls[0]![1][0]).toMatchObject({
      intentTapLeafScript: compiled.functionByName("renew")!.tapLeafScript,
      forfeitTapLeafScript: compiled.functionByName("renew")!.tapLeafScript,
    });
    expect(env.returned).toHaveBeenCalledOnce();
    expect(env.arkProvider.deleteIntent).not.toHaveBeenCalled();
    expect(env.handler.mock.calls[0]![4].expire_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("tunnels every asset from proof input 1 to covenant output 0", async () => {
    const assets = [{ assetId: "ab".repeat(32) + "0000", amount: 37n }];
    const env = setup({ ...coin, assets });
    await env.renew(contract, { ...coin, assets });
    const proof = Transaction.fromPSBT(base64.decode(env.emulator.submitIntent.mock.calls[0]![0].proof));
    const group = Extension.fromTx(proof).getAssetPacket()!.groups[0]!;
    expect(group.inputs[0]).toMatchObject({ vin: 1, amount: 37n });
    expect(group.outputs[0]).toMatchObject({ vout: 0, amount: 37n });
    expect(proof.getOutput(0).amount).toBe(1000n);
  });

  it.each([false, true])("uses actual swept status %s for past-expiry input fee", async (isSwept) => {
    const expired = { ...coin, isSwept, expiresAt: new Date(1000) };
    const env = setup(expired, { offchainInput: isSwept ? 'inputType == "recoverable" ? 0.0 : 100.0' : 'inputType == "vtxo" ? 0.0 : 100.0' });
    await expect(env.renew(contract, expired)).resolves.toBe("dd".repeat(32));
  });

  it.each([
    { isSwept: undefined, expiresAt: new Date(1000) }, { isSpent: true }, { isUnrolled: true },
    { value: 999 }, { script: "5120" + "ee".repeat(32) }, { commitmentTxIds: ["ee".repeat(32)] },
    { assets: [{ assetId: "ab".repeat(32) + "0000", amount: 1n }] },
  ])("rejects fresh indexer mismatch or unavailable renewal state %o", async (patch) => {
    const env = setup({ ...coin, ...patch });
    await expect(env.renew(contract, coin)).rejects.toThrow();
    expect(env.arkProvider.registerIntent).not.toHaveBeenCalled();
  });

  it("rejects missing coins, old versions and mismatched persisted scripts", async () => {
    const env = setup();
    env.indexer.getVtxos.mockResolvedValue({ vtxos: [] });
    await expect(env.renew(contract, coin)).rejects.toThrow();
    await expect(env.renew({ ...contract, params: { ...contract.params, version: "2" } }, coin)).rejects.toThrow();
    await expect(env.renew({ ...contract, script: "5120" + "ff".repeat(32) }, coin)).rejects.toThrow();
    expect(env.arkProvider.registerIntent).not.toHaveBeenCalled();
  });

  it("fails nonzero fees without fee payer instead of reducing principal", async () => {
    const env = setup(coin, { offchainInput: "10.0" });
    await expect(env.renew(contract, coin)).rejects.toThrow(/fee.*payer/i);
    expect(env.arkProvider.registerIntent).not.toHaveBeenCalled();
  });

  it("funds input and output fees from a separately signed payer input and change", async () => {
    const sponsor = await payer();
    const env = setup(coin, { offchainInput: "10.0", offchainOutput: "5.0" }, sponsor.wallet);
    env.indexer.getVirtualTxs.mockResolvedValue({ txs: [base64.encode(prev.toPSBT()), base64.encode(sponsor.tx.toPSBT())] });
    await env.renew(contract, coin);
    const proof = Transaction.fromPSBT(base64.decode(env.emulator.submitIntent.mock.calls[0]![0].proof));
    expect(proof.getOutput(0)).toMatchObject({ script: compiled.pkScript, amount: 1000n });
    expect(proof.getOutput(1)).toMatchObject({ script: hex.decode(sponsor.input.script), amount: 970n });
    expect(Intent.fee(proof)).toBe(30);
    expect(proof.getInput(1).tapScriptSig).toBeUndefined();
    expect(proof.getInput(2).tapScriptSig).toHaveLength(1);
    const signer = env.handler.mock.calls[0]![2];
    const forfeit = new Transaction({ allowUnknownOutputs: true });
    forfeit.addInput({ txid: sponsor.input.txid, index: 0, witnessUtxo: { script: hex.decode(sponsor.input.script), amount: 1000n }, tapLeafScript: [sponsor.input.forfeitTapLeafScript] });
    forfeit.addOutput({ script: compiled.pkScript, amount: 1000n });
    expect((await signer.sign(forfeit, [0])).getInput(0).tapScriptSig).toHaveLength(1);
    const foreign = previous(hex.decode(sponsor.input.script), 1000, 4);
    await expect(signer.sign(foreign, [0])).rejects.toThrow();
  });

  it("does not spend sponsor asset coins or accept insufficient fee funding", async () => {
    const sponsor = await payer(10);
    const env = setup(coin, { offchainInput: "10.0", offchainOutput: "5.0" }, sponsor.wallet);
    await expect(env.renew(contract, coin)).rejects.toThrow(/fund/i);
    sponsor.getSpendableVtxos.mockResolvedValue([{ ...sponsor.input, value: 1000, assets: [{ assetId: "ab".repeat(32) + "0000", amount: 1n }] }]);
    await expect(env.renew(contract, coin)).rejects.toThrow(/fund/i);
    expect(env.arkProvider.registerIntent).not.toHaveBeenCalled();
  });

  it("bounds fee payer selection by the advertised input limit including the proof input", async () => {
    const sponsor = await payer(15);
    sponsor.getSpendableVtxos.mockResolvedValue([1, 2, 3].map((n) => ({ ...sponsor.input, txid: hex.encode(new Uint8Array(32).fill(n)) })));
    const env = setup(coin, { offchainInput: "10.0" }, sponsor.wallet, 1000, 3);
    await expect(env.renew(contract, coin)).rejects.toThrow(/fund/i);
    expect(env.arkProvider.registerIntent).not.toHaveBeenCalled();
  });

  it("cancels a stalled batch on timeout", async () => {
    const env = setup(coin, {}, undefined, 10);
    env.join.mockImplementation(() => new Promise(() => {}));
    await expect(env.renew(contract, coin)).rejects.toThrow(/timed out/i);
    expect(env.arkProvider.getEventStream.mock.calls[0]![0].aborted).toBe(true);
  });

  it("uses a fresh, single cosigner session for every registration", async () => {
    const env = setup();
    await env.renew(contract, coin);
    const first = env.handler.mock.calls[0]![4].cosigners_public_keys;
    await env.renew(contract, coin);
    const second = env.handler.mock.calls[1]![4].cosigners_public_keys;
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first).not.toEqual(second);
    expect(env.handler.mock.calls[0]![5]).not.toBe(env.handler.mock.calls[1]![5]);
  });

  it("refuses finalization before the actual SDK handler validates the output tree", async () => {
    const swept = { ...coin, isSwept: true, expiresAt: new Date(1000) };
    const env = setup(swept);
    await env.renew(contract, swept);
    const handler = env.join.mock.calls[0]![1];
    const commitment = previous(compiled.pkScript, 1000, 3);
    await expect(handler.onBatchFinalization({
      type: SettlementEventType.BatchFinalization, id: "batch", commitmentTx: base64.encode(commitment.toPSBT()),
    })).rejects.toThrow(/virtual output tree signing did not run/);
    expect(env.emulator.submitFinalization).not.toHaveBeenCalled();
  });

  it("allows an exactly funded fee payer with no change output", async () => {
    const sponsor = await payer(20);
    const env = setup(coin, { offchainInput: "10.0" }, sponsor.wallet);
    env.indexer.getVirtualTxs.mockResolvedValue({ txs: [base64.encode(prev.toPSBT()), base64.encode(sponsor.tx.toPSBT())] });
    await env.renew(contract, coin);
    const proof = Transaction.fromPSBT(base64.decode(env.emulator.submitIntent.mock.calls[0]![0].proof));
    expect(proof.outputsLength).toBe(2);
    expect(proof.getOutput(0).amount).toBe(1000n);
    expect(Intent.fee(proof)).toBe(20);
  });

  it("propagates failures through the real SDK Batch.join event loop", async () => {
    const env = setup();
    env.join.mockRestore();
    env.arkProvider.getEventStream.mockImplementation(() => (async function* () {
      yield { type: SettlementEventType.BatchFailed, id: "batch", reason: "round rejected" };
    })());
    await expect(env.renew(contract, coin)).rejects.toThrow("round rejected");
    expect(env.arkProvider.registerIntent).toHaveBeenCalledOnce();
  });

  it("rejects an emulator response that changes the covenant output", async () => {
    const env = setup();
    env.emulator.submitIntent.mockImplementation(async ({ proof }) => {
      const tx = Transaction.fromPSBT(base64.decode(proof));
      tx.updateOutput(0, { amount: 999n });
      return base64.encode(tx.toPSBT());
    });
    await expect(env.renew(contract, coin)).rejects.toThrow(/changed renewal/);
    expect(env.arkProvider.registerIntent).not.toHaveBeenCalled();
  });

  it("cancels pending batch renewal on service shutdown", async () => {
    const env = setup();
    const shutdown = new AbortController();
    const renewer = createCovenantRenewer({ ...env.options, signal: shutdown.signal });
    env.join.mockImplementation(async () => {
      shutdown.abort(new Error("service shutdown"));
      return new Promise(() => {});
    });
    await expect(renewer.renew(contract, coin)).rejects.toThrow("service shutdown");
  });

  it("captures an event emitted immediately by registration and replays it to Batch.join", async () => {
    const env = setup();
    let listener: ((event: IteratorResult<SettlementEvent>) => void) | undefined;
    const event: SettlementEvent = { type: SettlementEventType.BatchFailed, id: "batch", reason: "immediate event" };
    env.arkProvider.getEventStream.mockImplementation(() => ({
      next: vi.fn(() => new Promise<IteratorResult<SettlementEvent>>((resolve) => { listener = resolve; })),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
      [Symbol.asyncIterator]() { return this; },
    }));
    env.arkProvider.registerIntent.mockImplementation(async () => {
      expect(listener).toBeDefined();
      listener!({ done: false, value: event });
      return "intent";
    });
    env.join.mockImplementation(async (stream) => {
      expect((await stream.next()).value).toEqual(event);
      return "dd".repeat(32);
    });
    await expect(env.renew(contract, coin)).resolves.toBe("dd".repeat(32));
  });

  it("cancels a failed zero-fee renewal with a sweep-leaf delete proof preserving assets", async () => {
    const assets = [{ assetId: "ab".repeat(32) + "0000", amount: 37n }];
    const env = setup({ ...coin, assets });
    env.join.mockRejectedValue(new Error("round rejected"));
    await expect(env.renew(contract, { ...coin, assets })).rejects.toThrow("round rejected");
    const deletion = env.arkProvider.deleteIntent.mock.calls[0]![0];
    expect(deletion.message.type).toBe("delete");
    const proof = Transaction.fromPSBT(base64.decode(deletion.proof));
    expect(proof.getInput(1).tapLeafScript).toEqual([compiled.functionByName("sweep")!.tapLeafScript]);
    expect(getArkPsbtFields(proof, 1, ConditionWitness)).toEqual([[params.preimage]]);
    expect(getArkPsbtFields(proof, 0, ConditionWitness)).toEqual([[params.preimage]]);
    expect(proof.getOutput(0)).toMatchObject({ amount: 0n, script: new Uint8Array([0x6a]) });
    expect(proof.getOutput(1)).toMatchObject({ amount: 1000n });
    expect(proof.getOutput(1).script).toEqual(ArkAddress.decode(params.staticAddress).pkScript);
    expect(Extension.fromTx(proof).getEmulatorPacket()!.entries[0]).toMatchObject({ vin: 1, script: compiled.functionByName("sweep")!.arkadeScript });
    const group = Extension.fromTx(proof).getAssetPacket()!.groups[0]!;
    expect(group.inputs[0]).toMatchObject({ vin: 1, amount: 37n });
    expect(group.outputs[0]).toMatchObject({ vout: 1, amount: 37n });
    expect(env.emulator.submitIntent.mock.calls[1]![0].message.type).toBe("delete");
  });

  it("cancels a sponsor-funded renewal using only the sponsor ownership proof", async () => {
    const sponsor = await payer();
    const env = setup(coin, { offchainInput: "10.0" }, sponsor.wallet);
    env.indexer.getVirtualTxs.mockResolvedValue({ txs: [base64.encode(prev.toPSBT()), base64.encode(sponsor.tx.toPSBT())] });
    env.join.mockRejectedValue(new Error("round rejected"));
    await expect(env.renew(contract, coin)).rejects.toThrow("round rejected");
    const deletion = env.arkProvider.deleteIntent.mock.calls[0]![0];
    const proof = Transaction.fromPSBT(base64.decode(deletion.proof));
    expect(proof.inputsLength).toBe(2);
    expect(hex.encode(proof.getInput(1).txid!)).toBe(sponsor.input.txid);
    expect(proof.getInput(1).tapScriptSig).toHaveLength(1);
    expect(proof.getInput(0).tapScriptSig).toHaveLength(1);
    expect(env.emulator.submitIntent).toHaveBeenCalledOnce();
  });

  it("times out even when the initial emulator submission never resolves", async () => {
    const env = setup(coin, {}, undefined, 10);
    env.emulator.submitIntent.mockImplementation(() => new Promise(() => {}));
    await expect(env.renew(contract, coin)).rejects.toThrow(/timed out/i);
    expect(env.arkProvider.registerIntent).not.toHaveBeenCalled();
    expect(env.arkProvider.deleteIntent).not.toHaveBeenCalled();
  });

  it("logs failed cleanup while preserving the original batch failure", async () => {
    const env = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    env.join.mockRejectedValue(new Error("batch failed"));
    env.arkProvider.deleteIntent.mockRejectedValue(new Error("offline"));
    await expect(env.renew(contract, coin)).rejects.toThrow("batch failed");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("may remain registered"), expect.any(Error));
  });

  it("preserves plain sponsor forfeits when the emulator only returns covenant forfeits", async () => {
    const sponsor = await payer();
    const env = setup(coin, { offchainInput: "10.0" }, sponsor.wallet);
    env.indexer.getVirtualTxs.mockResolvedValue({ txs: [base64.encode(prev.toPSBT()), base64.encode(sponsor.tx.toPSBT())] });
    const covenantForfeit = previous(compiled.pkScript, 1000, 1);
    covenantForfeit.updateInput(0, { txid: coin.txid, index: coin.vout });
    const sponsorForfeit = previous(compiled.pkScript, sponsor.input.value, 2);
    sponsorForfeit.updateInput(0, { txid: sponsor.input.txid, index: sponsor.input.vout });
    const returnedCovenant = base64.encode(covenantForfeit.toPSBT());
    const omittedSponsor = base64.encode(sponsorForfeit.toPSBT());
    env.join.mockImplementation(async () => {
      const batchEmulator = env.handler.mock.calls[0]![7];
      env.emulator.submitFinalization.mockResolvedValue({ signedForfeits: [returnedCovenant], signedCommitmentTx: null });
      const result = await batchEmulator.submitFinalization(
        { proof: env.emulator.submitIntent.mock.calls[0]![0].proof, message: env.handler.mock.calls[0]![4] },
        [returnedCovenant, omittedSponsor], null, returnedCovenant,
      );
      expect(result.signedForfeits).toEqual([returnedCovenant, omittedSponsor]);
      env.emulator.submitFinalization.mockResolvedValue({ signedForfeits: [returnedCovenant, omittedSponsor], signedCommitmentTx: null });
      expect((await batchEmulator.submitFinalization(
        { proof: env.emulator.submitIntent.mock.calls[0]![0].proof, message: env.handler.mock.calls[0]![4] },
        [returnedCovenant, omittedSponsor], null, returnedCovenant,
      )).signedForfeits).toHaveLength(2);
      return "dd".repeat(32);
    });
    await env.renew(contract, coin);
  });

  it("cancels registration that completes after the operation already timed out", async () => {
    const env = setup(coin, {}, undefined, 10);
    let finish: ((id: string) => void) | undefined;
    env.arkProvider.registerIntent.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await expect(env.renew(contract, coin)).rejects.toThrow(/timed out/);
    const cancellations = env.arkProvider.deleteIntent.mock.calls.length;
    finish!("late intent");
    await vi.waitFor(() => expect(env.arkProvider.deleteIntent.mock.calls.length).toBe(cancellations + 1));
    expect(env.join).not.toHaveBeenCalled();
  });

  it("retries cleanup after an ambiguous registration rejects after the timeout", async () => {
    const env = setup(coin, {}, undefined, 10);
    let fail: ((error: Error) => void) | undefined;
    env.arkProvider.registerIntent.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    await expect(env.renew(contract, coin)).rejects.toThrow(/timed out/);
    const cancellations = env.arkProvider.deleteIntent.mock.calls.length;
    fail!(new Error("lost registration response"));
    await vi.waitFor(() => expect(env.arkProvider.deleteIntent.mock.calls.length).toBe(cancellations + 1));
    expect(env.join).not.toHaveBeenCalled();
  });

  it("bounds cleanup independently when cancellation RPC never responds", async () => {
    const env = setup(coin, {}, undefined, 30);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    env.join.mockRejectedValue(new Error("batch failed"));
    env.arkProvider.deleteIntent.mockImplementation(() => new Promise(() => {}));
    await expect(env.renew(contract, coin)).rejects.toThrow("batch failed");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("may remain registered"), expect.objectContaining({ message: "renewal intent cleanup timed out" }));
  });

  it("falls back to covenant cancellation when fresh sponsors do not match an abandoned intent", async () => {
    const sponsor = await payer();
    const env = setup(coin, { offchainInput: "10.0" }, sponsor.wallet);
    env.indexer.getVirtualTxs.mockResolvedValue({ txs: [base64.encode(prev.toPSBT()), base64.encode(sponsor.tx.toPSBT())] });
    env.arkProvider.registerIntent.mockRejectedValue(new Error("duplicated input"));
    env.arkProvider.deleteIntent.mockRejectedValueOnce(new Error("no matching intents found")).mockResolvedValue(undefined);
    await expect(env.renew(contract, coin)).rejects.toThrow("duplicated input");
    expect(env.arkProvider.deleteIntent).toHaveBeenCalledTimes(2);
    const fallback = Transaction.fromPSBT(base64.decode(env.arkProvider.deleteIntent.mock.calls[1]![0].proof));
    expect(hex.encode(fallback.getInput(1).txid!)).toBe(coin.txid);
    expect(fallback.getInput(1).tapLeafScript).toEqual([compiled.functionByName("sweep")!.tapLeafScript]);
  });

  it("blocks delayed batch signatures after cancellation", async () => {
    const env = setup();
    env.join.mockRejectedValue(new Error("cancel batch"));
    await expect(env.renew(contract, coin)).rejects.toThrow("cancel batch");
    const provider = env.handler.mock.calls[0]![6];
    await expect(provider.submitSignedForfeitTxs([])).rejects.toThrow("cancel batch");
    expect(env.arkProvider.submitSignedForfeitTxs).not.toHaveBeenCalled();
  });
});
