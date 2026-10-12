import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  arkade, ArkAddress, Batch, ConditionWitness, EmulatorPacket, Estimator, Extension, Intent, SingleKey, createAssetPacket, isVtxoSpent, setArkPsbtField, withPrevTxs,
  type ArkProvider, type Contract, type EmulatorProvider, type ExtendedVirtualCoin, type Identity,
  Transaction, type IndexerProvider, type Network, type SettlementEvent, type VirtualCoin, type Wallet,
} from "@arkade-os/sdk";
import { covenantDestinationHandler, COVENANT_CONTRACT_TYPE } from "./contract.js";
import { compileCovenantV3 } from "./program.js";

const assetsKey = (coin: VirtualCoin) => (coin.assets ?? []).map((a) => `${a.assetId}:${a.amount}`).sort().join(",");
const commitmentsKey = (coin: VirtualCoin) => (coin.commitmentTxIds ?? []).slice().sort().join(",");
const feeInput = (coin: VirtualCoin) => ({
  amount: BigInt(coin.value), type: coin.isSwept ? "recoverable" as const : "vtxo" as const,
  weight: 0, birth: coin.createdAt, expiry: coin.expiresAt,
});

export function createCovenantRenewer(opts: {
  arkProvider: ArkProvider;
  indexer: IndexerProvider;
  emulator: EmulatorProvider;
  network: Network;
  feePayer?: Wallet;
  timeoutMs?: number;
  signal?: AbortSignal;
}): { renew(contract: Contract, vtxo: VirtualCoin): Promise<string> } {
  const { arkProvider, indexer, emulator, network, feePayer } = opts;

  async function renew(contract: Contract, vtxo: VirtualCoin): Promise<string> {
    const abort = new AbortController();
    const cancel = () => abort.abort(opts.signal?.reason ?? new Error("renewal canceled"));
    if (opts.signal?.aborted) cancel();
    opts.signal?.addEventListener("abort", cancel, { once: true });
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    const timeout = setTimeout(() => abort.abort(new Error("covenant renewal timed out")), timeoutMs);
    let stream: AsyncIterableIterator<SettlementEvent> | undefined;
    let registrationStarted = false;
    let committed = false;
    let cancelRegistration: () => Promise<void> = async () => {};
    const execute = async (): Promise<string> => {
      abort.signal.throwIfAborted();
      const params = covenantDestinationHandler.deserializeParams(contract.params);
      if (contract.type !== COVENANT_CONTRACT_TYPE || params.version !== 3) throw new Error("renewal requires a v3 covenant");
      const compiled = compileCovenantV3(params);
      if (hex.encode(compiled.pkScript) !== contract.script) throw new Error("covenant contract script mismatch");
      const renewal = compiled.functionByName("renew")!;
      const fresh = (await indexer.getVtxos({ outpoints: [{ txid: vtxo.txid, vout: vtxo.vout }] })).vtxos;
      const coin = fresh[0];
      if (fresh.length !== 1 || !coin || coin.txid !== vtxo.txid || coin.vout !== vtxo.vout ||
        coin.script !== contract.script || coin.script !== vtxo.script || coin.value !== vtxo.value ||
        assetsKey(coin) !== assetsKey(vtxo) || commitmentsKey(coin) !== commitmentsKey(vtxo))
        throw new Error("fresh covenant outpoint mismatch or missing");
      if (!Number.isSafeInteger(coin.value) || coin.value <= 0 || isVtxoSpent(coin) || coin.isUnrolled)
        throw new Error("covenant outpoint cannot be renewed");
      if (((coin.expiresAt && coin.expiresAt.getTime() <= Date.now()) || coin.expiresAtHeight !== undefined) &&
        typeof coin.isSwept !== "boolean") throw new Error("expired covenant requires actual swept status");

      const info = await arkProvider.getInfo();
      const maxInputs = Math.min(128, Number((info as typeof info & { maxTxInputs?: number | bigint }).maxTxInputs ?? 128));
      if (!Number.isSafeInteger(maxInputs) || maxInputs < 2) throw new Error("renewal intent input limit is invalid");
      const estimator = new Estimator(info.fees.intentFee);
      const outputs = [{ script: compiled.pkScript, amount: BigInt(coin.value) }];
      const covenantFee = estimator.evalOffchainInput(feeInput(coin)).satoshis +
        estimator.evalOffchainOutput({ amount: BigInt(coin.value), script: coin.script }).satoshis;
      const sponsors: ExtendedVirtualCoin[] = [];
      if (covenantFee > 0) {
        if (!feePayer) throw new Error("nonzero renewal fee requires a separate fee payer");
        const changeScript = ArkAddress.decode(await feePayer.getAddress()).pkScript;
        const candidates = (await feePayer.getSpendableVtxos({ withRecoverable: false, genericallySpendableOnly: true }))
          .filter((c) => !c.assets?.length && !isVtxoSpent(c) && !c.isUnrolled && !c.isSwept &&
            (!c.expiresAt || c.expiresAt.getTime() > Date.now()) && Number.isSafeInteger(c.value) && c.value > 0 &&
            !(c.txid === coin.txid && c.vout === coin.vout))
          .sort((a, b) => b.value - a.value);
        let total = 0;
        let fees = covenantFee;
        let funded = false;
        for (const candidate of candidates) {
          if (sponsors.length + 2 >= maxInputs) break;
          if (sponsors.some((c) => c.txid === candidate.txid && c.vout === candidate.vout)) continue;
          sponsors.push(candidate);
          total += candidate.value;
          fees += estimator.evalOffchainInput(feeInput(candidate)).satoshis;
          if (!Number.isSafeInteger(total) || !Number.isSafeInteger(fees) || fees < 0) throw new Error("invalid renewal fee funding");
          if (total === fees) { funded = true; break; }
          let change = total - fees;
          for (let iteration = 0; iteration < 32 && change >= Number(info.dust); iteration++) {
            const next = total - fees - estimator.evalOffchainOutput({ amount: BigInt(change), script: hex.encode(changeScript) }).satoshis;
            if (next === change) {
              outputs.push({ script: changeScript, amount: BigInt(change) });
              funded = true;
              break;
            }
            change = next;
          }
          if (funded) break;
        }
        if (!funded) throw new Error("insufficient separate renewal fee funding");
      } else if (!Number.isSafeInteger(covenantFee) || covenantFee < 0) throw new Error("invalid covenant renewal fee");

      const session = SingleKey.fromPrivateKey(secp256k1.utils.randomSecretKey()).signerSession();
      const sessionPubkey = hex.encode(await session.getPublicKey());
      const signer: Identity = {
        sign: async (tx, indexes) => {
          const owned: number[] = [];
          for (const index of indexes ?? Array.from({ length: tx.inputsLength }, (_, i) => i)) {
            const input = tx.getInput(index);
            const sponsor = sponsors.find((c) => input.txid && hex.encode(input.txid) === c.txid && input.index === c.vout);
            if (sponsor) {
              if (input.witnessUtxo?.amount !== BigInt(sponsor.value) || !input.witnessUtxo?.script ||
                hex.encode(input.witnessUtxo.script) !== sponsor.script ||
                ![sponsor.forfeitTapLeafScript, sponsor.intentTapLeafScript].some((leaf) =>
                  JSON.stringify(input.tapLeafScript) === JSON.stringify([leaf])))
                throw new Error("fee payer signing input mismatch");
              owned.push(index);
            } else if (indexes && !(input.txid && hex.encode(input.txid) === coin.txid && input.index === coin.vout)) {
              throw new Error("unexpected renewal signing input");
            }
          }
          return owned.length ? feePayer!.identity.sign(tx, owned) : tx;
        },
        signerSession: () => session,
        signMessage: async () => new Uint8Array(),
        compressedPublicKey: async () => new Uint8Array(33),
        xOnlyPublicKey: async () => new Uint8Array(32),
      };
      const inputs = await withPrevTxs([{
        ...coin, tapTree: compiled.encode(),
        intentTapLeafScript: renewal.tapLeafScript, forfeitTapLeafScript: renewal.tapLeafScript,
        arkadeScriptBytes: renewal.arkadeScript!,
      }, ...sponsors.map((c) => ({ ...c, arkadeScriptBytes: new Uint8Array() }))], indexer);
      const packets = [EmulatorPacket.create([{ vin: 1, script: renewal.arkadeScript!, witness: new Uint8Array() }])];
      const extension = Extension.create(coin.assets?.length
        ? [...packets, createAssetPacket(new Map([[1, coin.assets]]), [{ address: contract.address, amount: coin.value, assets: coin.assets }])]
        : packets);
      const message: Intent.RegisterMessage = {
        type: "register", onchain_output_indexes: [], valid_at: 0, expire_at: Math.ceil(deadline / 1000), cosigners_public_keys: [sessionPubkey],
      };
      const proof = await signer.sign(Intent.create(message, inputs, [...outputs, extension.txOut()]), sponsors.map((_, i) => i + 2));
      cancelRegistration = async () => {
        const cleanup = new AbortController();
        const cleanupMs = Math.min(timeoutMs, 5000);
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        const deletion = async () => {
          const deleteMessage: Intent.DeleteMessage = { type: "delete", expire_at: Math.ceil((Date.now() + cleanupMs) / 1000) };
          if (sponsors.length) {
            const unsigned = Intent.create(deleteMessage, inputs.slice(1), []);
            const synthetic = unsigned.getInput(0);
            if (synthetic.witnessUtxo?.amount !== 0n || !synthetic.witnessUtxo.script ||
              hex.encode(synthetic.witnessUtxo.script) !== sponsors[0]!.script ||
              JSON.stringify(synthetic.tapLeafScript) !== JSON.stringify([sponsors[0]!.intentTapLeafScript]))
              throw new Error("fee payer deletion proof input mismatch");
            const transaction = await feePayer!.identity.sign(unsigned, [0, ...sponsors.map((_, i) => i + 1)]);
            cleanup.signal.throwIfAborted();
            try {
              await arkProvider.deleteIntent({ proof: base64.encode(transaction.toPSBT()), message: deleteMessage });
              return;
            } catch { cleanup.signal.throwIfAborted(); }
          }
          const sweep = compiled.functionByName("sweep")!;
          const deletePackets = [EmulatorPacket.create([{ vin: 1, script: sweep.arkadeScript!, witness: new Uint8Array() }])];
          const deleteExtension = Extension.create(coin.assets?.length
            ? [...deletePackets, createAssetPacket(new Map([[1, coin.assets]]), [
              { address: "", amount: 0 }, { address: params.staticAddress, amount: coin.value, assets: coin.assets },
            ])] : deletePackets);
          const transaction = Intent.create(deleteMessage, [{ ...inputs[0]!, intentTapLeafScript: sweep.tapLeafScript }], [
            { script: new Uint8Array([0x6a]), amount: 0n },
            { script: ArkAddress.decode(params.staticAddress).pkScript, amount: BigInt(coin.value) }, deleteExtension.txOut(),
          ]);
          for (const vin of [0, 1]) setArkPsbtField(transaction, vin, ConditionWitness, [params.preimage]);
          // The endpoint accepts generic intent messages; rc.17's declaration only names register.
          const submit = emulator.submitIntent as (intent: { proof: string; message: Intent.Message }) => Promise<string>;
          const deleteProof = await submit.call(emulator, { proof: base64.encode(transaction.toPSBT()), message: deleteMessage });
          if (Transaction.fromPSBT(base64.decode(deleteProof)).id !== transaction.id) throw new Error("emulator changed renewal deletion");
          cleanup.signal.throwIfAborted();
          await arkProvider.deleteIntent({ proof: deleteProof, message: deleteMessage });
        };
        try {
          await Promise.race([deletion(), new Promise<never>((_, reject) => {
            cleanupTimer = setTimeout(() => {
              const error = new Error("renewal intent cleanup timed out");
              cleanup.abort(error);
              reject(error);
            }, cleanupMs);
          })]);
        } catch (error) {
          console.warn(`Renewal intent for ${coin.txid}:${coin.vout} may remain registered; cancellation failed`, error);
        } finally { clearTimeout(cleanupTimer); }
      };
      abort.signal.throwIfAborted();
      const signedProof = await emulator.submitIntent({ proof: base64.encode(proof.toPSBT()), message });
      if (Transaction.fromPSBT(base64.decode(signedProof)).id !== proof.id) throw new Error("emulator changed renewal transaction");
      abort.signal.throwIfAborted();
      stream = arkProvider.getEventStream(abort.signal, [sessionPubkey, ...inputs.map((c) => `${c.txid}:${c.vout}`)]);
      const firstNext = stream.next();
      void firstNext.catch(() => {});
      const primedStream = (async function* () {
        const first = await firstNext;
        if (!first.done) yield first.value;
        yield* stream!;
      })();
      abort.signal.throwIfAborted();
      registrationStarted = true;
      let intentId: string;
      try {
        intentId = await arkProvider.registerIntent({ proof: signedProof, message });
      } catch (error) {
        if (abort.signal.aborted) await cancelRegistration();
        throw error;
      }
      if (abort.signal.aborted) {
        await cancelRegistration();
        abort.signal.throwIfAborted();
      }
      const batchEmulator = {
        ...emulator,
        submitFinalization: async (...args: Parameters<EmulatorProvider["submitFinalization"]>) => {
          abort.signal.throwIfAborted();
          const result = await emulator.submitFinalization(...args);
          abort.signal.throwIfAborted();
          const returned = new Set(result.signedForfeits.map((tx) => Transaction.fromPSBT(base64.decode(tx)).id));
          const missingSponsors = args[1].filter((encoded) => {
            const transaction = Transaction.fromPSBT(base64.decode(encoded));
            const input = transaction.getInput(0);
            return !returned.has(transaction.id) && sponsors.some((c) => input.txid && hex.encode(input.txid) === c.txid && input.index === c.vout);
          });
          return { ...result, signedForfeits: [...result.signedForfeits, ...missingSponsors] };
        },
      };
      const batchProvider: ArkProvider = {
        ...arkProvider,
        getInfo: () => arkProvider.getInfo(),
        confirmRegistration: async (id) => {
          abort.signal.throwIfAborted();
          await arkProvider.confirmRegistration(id);
        },
        submitTreeNonces: async (...args) => {
          abort.signal.throwIfAborted();
          await arkProvider.submitTreeNonces(...args);
        },
        submitTreeSignatures: async (...args) => {
          abort.signal.throwIfAborted();
          await arkProvider.submitTreeSignatures(...args);
        },
        submitSignedForfeitTxs: async (...args) => {
          abort.signal.throwIfAborted();
          await arkProvider.submitSignedForfeitTxs(...args);
        },
      };
      const handler = arkade.createArkadeBatchHandler(intentId, inputs, signer, signedProof, message, session, batchProvider, batchEmulator, network);
      abort.signal.throwIfAborted();
      const commitmentTxid = await Batch.join(primedStream, handler, { abortController: abort });
      committed = true;
      return commitmentTxid;
    };
    let onAbort: () => void = () => {};
    try {
      return await Promise.race([execute(), new Promise<never>((_, reject) => {
        onAbort = () => reject(abort.signal.reason);
        abort.signal.addEventListener("abort", onAbort, { once: true });
        if (abort.signal.aborted) onAbort();
      })]);
    } catch (error) {
      abort.abort(error);
      if (registrationStarted && !committed) await cancelRegistration();
      throw error;
    } finally {
      clearTimeout(timeout);
      abort.signal.removeEventListener("abort", onAbort);
      opts.signal?.removeEventListener("abort", cancel);
      abort.abort();
      void stream?.return?.().catch(() => {});
    }
  }
  return { renew };
}
