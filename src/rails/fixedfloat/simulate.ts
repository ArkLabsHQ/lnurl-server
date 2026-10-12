// A FixedFloat stand-in for networks FixedFloat cannot serve. It answers the v2 methods
// in-process, so the client, the rates pipeline and the callback run exactly as against
// ff.io, and it takes no deposit at all. Its chains are testnets and every id it hands out
// says ffsim, so nothing from it can be mistaken for the real rail or move mainnet tokens.

import { createHash, randomBytes } from "node:crypto";
import { base58, createBase58check, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { FfApiError, type FfMethod, type FfTransport } from "./client.js";
import { namespaceOf, type FfAsset } from "./catalogue.js";
import { formatUnits } from "./uri.js";
import type { StoredFfOrder } from "../../ff-order-store.js";

export const SIM_ASSETS: Readonly<Record<string, FfAsset>> = {
  USDTARBITRUM: { chain: "eip155:421614", ns: "erc20", unit: "USDT", decimals: 6 },
  USDCBASE: { chain: "eip155:84532", ns: "erc20", unit: "USDC", decimals: 6 },
  USDTSOL: { chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", ns: "token", unit: "USDT", decimals: 6 },
  USDTTRC: { chain: "tron:0xcd8690dc", ns: "trc20", unit: "USDT", decimals: 6 },
};

/** BTC per token, and the token range: roughly 1 000 to 1 000 000 sats. */
const RATE = 0.0000118;
const MIN_TOKENS = 0.85;
const MAX_TOKENS = 850;

const tronCheck = createBase58check(sha256);
const seed = (label: string) => createHash("sha512").update(label).digest();

function addressFor(namespace: string, bytes: Uint8Array): string {
  if (namespace === "eip155") return "0x" + hex.encode(bytes.slice(0, 20));
  if (namespace === "solana") return base58.encode(bytes.slice(0, 32));
  return tronCheck.encode(Uint8Array.from([0x41, ...bytes.slice(0, 20)]));
}

/** A deposit txid in the chain's own shape: 0x hex, a 64-byte base58 signature, or bare hex. */
function txidFor(namespace: string, orderId: string): string {
  const bytes = seed(`ffsim-deposit:${orderId}`);
  if (namespace === "eip155") return "0x" + hex.encode(bytes.slice(0, 32));
  if (namespace === "solana") return base58.encode(bytes);
  return hex.encode(bytes.slice(0, 32));
}

export function simulatedRatesXml(): string {
  const items = Object.keys(SIM_ASSETS).map((code) =>
    `<item><from>${code}</from><to>BTCLN</to><in>1</in><out>${RATE.toFixed(8)}</out>` +
    `<minamount>${MIN_TOKENS} ${code}</minamount><maxamount>${MAX_TOKENS} ${code}</maxamount></item>`);
  return `<rates>${items.join("")}</rates>`;
}

export interface SimulatedOrders {
  /** The stored order behind an id, and whether the corridor swap it pays has settled. */
  find(orderId: string): { order: StoredFfOrder; settled: boolean } | undefined;
}

interface OrderShape {
  id: string; token: string; status: string; code: string; amount: string; address: string; toAmount: string;
  expiration: number; now: number; txid: string | null;
}

const orderAnswer = (o: OrderShape) => ({
  id: o.id, token: o.token, type: "fixed", status: o.status,
  time: { reg: o.now, expiration: o.expiration, left: Math.max(0, o.expiration - o.now) },
  from: { code: o.code, amount: o.amount, address: o.address, tag: null, tx: { id: o.txid } },
  to: { code: "BTCLN", amount: o.toAmount },
  emergency: { status: [], choice: "NONE", repeat: false },
});

/** Order state is read back from the store, so the simulator holds none and survives a
 *  restart. An order reports DONE, with a deposit txid, once its corridor swap settled. */
export function simulatedTransport(opts: { orders: SimulatedOrders; windowSeconds?: number; now?: () => number }): FfTransport {
  const now = () => Math.floor((opts.now ?? Date.now)() / 1000);
  const window = opts.windowSeconds ?? 900;
  const quote = (method: FfMethod, body: Record<string, unknown>) => {
    const code = String(body.fromCcy);
    const asset = SIM_ASSETS[code];
    if (!asset || body.toCcy !== "BTCLN" || body.type !== "fixed" || body.direction !== "to") throw new FfApiError(method, 301, "Unsupported pair");
    const toAmount = Number(body.amount);
    const fromAmount = Math.ceil((toAmount / RATE) * 1000) / 1000;
    const errors = fromAmount < MIN_TOKENS ? ["LIMIT_MIN"] : fromAmount > MAX_TOKENS ? ["LIMIT_MAX"] : [];
    return { code, asset, toAmount, fromAmount, errors };
  };

  return {
    async call(method, data) {
      const body = data as Record<string, unknown>;
      if (method === "ccies") {
        return [
          ...Object.entries(SIM_ASSETS).map(([code, asset]) => ({
            code, coin: asset.unit, network: namespaceOf(asset.chain), recv: 1, send: 1, tag: null,
            contract: addressFor(namespaceOf(asset.chain), seed(`ffsim-contract:${code}`)),
          })),
          { code: "BTCLN", coin: "BTC", network: "LN", recv: 1, send: 1, tag: null, contract: null },
        ];
      }
      if (method === "price") {
        const q = quote(method, body);
        return { from: { code: q.code, amount: q.fromAmount, btc: Number((q.toAmount * 1.01).toFixed(8)) }, to: { code: "BTCLN", amount: q.toAmount }, errors: q.errors };
      }
      if (method === "create") {
        const q = quote(method, body);
        if (q.errors.length) throw new FfApiError(method, 301, q.errors.join(","));
        if (typeof body.toAddress !== "string" || !body.toAddress.startsWith("ln")) throw new FfApiError(method, 304, "Invalid route, unable to find a path to destination");
        const at = now();
        return orderAnswer({
          id: `ffsim-${randomBytes(3).toString("hex")}`, token: randomBytes(20).toString("hex"), status: "NEW", code: q.code,
          amount: String(q.fromAmount), address: addressFor(namespaceOf(q.asset.chain), randomBytes(32)), toAmount: q.toAmount.toFixed(8),
          expiration: at + window, now: at, txid: null,
        });
      }
      const found = opts.orders.find(String(body.id));
      if (!found || found.order.token !== body.token) throw new FfApiError(method, 404, "Order not found");
      const { order, settled } = found;
      const at = now();
      return orderAnswer({
        id: order.orderId, token: order.token, status: settled ? "DONE" : at >= order.expiresAt ? "EXPIRED" : "NEW", code: order.ffCode,
        amount: formatUnits(order.depositAmount, SIM_ASSETS[order.ffCode]?.decimals ?? 6), address: order.depositAddress,
        toAmount: (order.invoiceAmountSat / 1e8).toFixed(8), expiration: order.expiresAt, now: at,
        txid: settled ? txidFor(namespaceOf(order.asset), order.orderId) : null,
      });
    },
  };
}
