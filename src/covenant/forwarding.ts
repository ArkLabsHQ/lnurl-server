import { base64, hex } from "@scure/base";
import { ArkAddress, Transaction, type Asset, type IndexerProvider, type Outpoint, type VirtualCoin } from "@arkade-os/sdk";
import type { SettlementStore } from "../settlement-store.js";

const samePoint = (a: Outpoint, b: Outpoint): boolean => a.txid === b.txid && a.vout === b.vout;
const sameAssets = (a: readonly Asset[] = [], b: readonly Asset[] = []): boolean => {
  const holdings = (assets: readonly Asset[]) => assets.map(({ assetId, amount }) => `${assetId}:${amount}`).sort().join("|");
  return holdings(a) === holdings(b);
};

export async function reconcileCovenantForwarding(
  store: SettlementStore,
  script: string,
  destination: string,
  coins: readonly VirtualCoin[],
  indexer: IndexerProvider,
): Promise<void> {
  const record = store.findByCovenantScript(script);
  if (!record?.settled || record.payoutReference) return;
  let current = record.covenantOutpoint;
  if (!current) {
    const received = coins.filter((coin) => coin.txid === record.paymentReference && coin.value * 1000 >= (record.amountMsat ?? 0));
    if (received.length !== 1) throw new Error("covenant receipt outpoint is unavailable or ambiguous");
    current = { txid: received[0]!.txid, vout: received[0]!.vout };
    if (!store.setCovenantOutpoint(record.paymentHash, current, null)) throw new Error("covenant outpoint changed concurrently");
  }
  const seen = new Set<string>();
  for (let depth = 0; depth < 64; depth++) {
    const key = `${current.txid}:${current.vout}`;
    if (seen.has(key)) throw new Error("cyclic covenant renewal history");
    seen.add(key);
    const coin = coins.find((candidate) => samePoint(candidate, current!));
    if (!coin) throw new Error("covenant outpoint is unavailable");
    if (!coin.isSpent) return;
    if (coin.arkTxId) {
      const ids = [coin.arkTxId, ...(coin.spentBy ? [coin.spentBy] : [])];
      const transactions = (await indexer.getVirtualTxs(ids)).txs.map((psbt) => Transaction.fromPSBT(base64.decode(psbt)));
      const spend = transactions.find((tx) => tx.id === coin.arkTxId);
      if (!spend) throw new Error("covenant payout transaction is unavailable");
      const checkpoint = coin.spentBy ? transactions.find((tx) => tx.id === coin.spentBy) : undefined;
      const spends = (tx: Transaction, point: Outpoint): number => {
        for (let i = 0; i < tx.inputsLength; i++) {
          const input = tx.getInput(i);
          if (input.txid && hex.encode(input.txid) === point.txid && input.index === point.vout) return i;
        }
        return -1;
      };
      let vin = spends(spend, current);
      if (vin < 0 && checkpoint && spends(checkpoint, current) >= 0) vin = spends(spend, { txid: checkpoint.id, vout: 0 });
      if (vin < 0 || vin >= spend.outputsLength) throw new Error("covenant payout does not spend the tracked outpoint");
      const output = spend.getOutput(vin);
      const target = ArkAddress.decode(destination).pkScript;
      if (!output.script || hex.encode(output.script) !== hex.encode(target) || (output.amount ?? 0n) < BigInt(coin.value)) {
        throw new Error("covenant payout changed the recipient or value");
      }
      const payout = (await indexer.getVtxos({ outpoints: [{ txid: spend.id, vout: vin }] })).vtxos.find((v) => v.txid === spend.id && v.vout === vin);
      if (!payout || payout.script !== hex.encode(target) || payout.value < coin.value || !sameAssets(coin.assets, payout.assets)) {
        throw new Error("covenant payout assets or output evidence mismatch");
      }
      store.markPaidOut(record.paymentHash, spend.id);
      return;
    }
    if (!coin.settledBy) throw new Error("covenant spend has no renewal or payout evidence");
    const successors = coins.filter((candidate) => !samePoint(candidate, current!) &&
      candidate.commitmentTxIds?.includes(coin.settledBy!) && candidate.script === script &&
      candidate.value === coin.value && sameAssets(coin.assets, candidate.assets));
    if (successors.length !== 1) throw new Error("covenant renewal successor is unavailable or ambiguous");
    const successor = { txid: successors[0]!.txid, vout: successors[0]!.vout };
    if (!store.setCovenantOutpoint(record.paymentHash, successor, current)) throw new Error("covenant outpoint changed concurrently");
    current = successor;
  }
  throw new Error("covenant renewal history exceeds the reconciliation limit");
}
