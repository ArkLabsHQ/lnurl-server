import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { base58, createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";

/** FixedFloat v2's answer envelope: `code: 0` is success. */
export interface FfEnvelope { code: number; msg: string; data: unknown }
export const ok = (data: unknown): FfEnvelope => ({ code: 0, msg: "OK", data });
export const fail = (code: number, msg: string): FfEnvelope => ({ code, msg, data: null });

/** One `<item>` of rates/fixed.xml. `min`/`max` are bare numbers; the XML appends the code. */
export interface FakeRate { from: string; to: string; out: string; tofee?: string; min: string; max: string }

export type FakeOrder = Record<string, any> & { id: string; token: string; status: string };

export interface FakeFf {
  baseUrl: string;
  ratesUrl: string;
  apiKey: string;
  secret: string;
  /** Signed calls that reached a handler, with FF's documented weight. */
  calls: { method: string; weight: number; body: Record<string, any> }[];
  ccies: Record<string, unknown>[];
  rates: FakeRate[];
  ratesStatus: number;
  orders: Map<string, FakeOrder>;
  /** Seconds a created order stays open for deposit. */
  windowSeconds: number;
  price: (body: Record<string, any>) => FfEnvelope;
  create: (body: Record<string, any>) => FfEnvelope;
  order: (body: Record<string, any>) => FfEnvelope;
  close(): Promise<void>;
}

const EVM = ["ARBITRUM", "ETH", "BASE", "OP", "MATIC", "AVAXC", "BSC"];
// [code, coin, network, contract, out, min, max, tofee] from the 2026-10-07 captures.
const CATALOGUE: [string, string, string, string | null, string, string, string, string][] = [
  ["USDTARBITRUM", "USDT", "ARBITRUM", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "0.000011868696", "2.3959966639", "15013.5500000000", "0.0000016800"],
  ["USDCARBITRUM", "USDC", "ARBITRUM", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", "0.000011873265", "2.4115271059", "15007.7730000000", "0.0000016900"],
  ["USDT", "USDT", "ETH", "0xdac17f958d2ee523a2206206994597c13d831ec7", "0.000011868696", "31.6513761468", "15013.6210000000", "0.0000025300"],
  ["USDCETH", "USDC", "ETH", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0.000011873265", "31.6418807339", "15007.8429000000", "0.0000025300"],
  ["USDCBASE", "USDC", "BASE", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0.000011873265", "2.1263419516", "15007.7580000000", "0.0000015100"],
  ["USDCOP", "USDC", "OP", "0x0b2c639c533813f4aa9d7837caf62653d097ff85", "0.000011873265", "2.1263419516", "15007.7581000000", "0.0000015100"],
  ["USDTMATIC", "USDT", "MATIC", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", "0.000011868696", "2.1430859049", "15013.5370000000", "0.0000015200"],
  ["USDCMATIC", "USDC", "MATIC", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "0.000011873265", "2.1421351126", "15007.7595000000", "0.0000015200"],
  ["USDTAVAX", "USDT", "AVAXC", "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", "0.000011868696", "2.1111342786", "15013.5350000000", "0.0000015000"],
  ["USDCAVAX", "USDC", "AVAXC", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", "0.000011873265", "2.1107589658", "15007.7575000000", "0.0000015000"],
  ["USDTSOL", "USDT", "SOL", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "0.000011868696", "2.4759633028", "15013.5540000000", "0.0000017300"],
  ["USDCSOL", "USDC", "SOL", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "0.000011873265", "2.4759633028", "15007.7767000000", "0.0000017300"],
  ["USDTTRC", "USDT", "TRX", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "0.000011868696", "10.1075854879", "15013.8710000000", "0.0000055300"],
  ["USDTBSC", "USDT", "BSC", "0x55d398326f99059ff775485246999027b3197955", "0.000011868696", "2.1430859049", "15013.5370000000", "0.0000015200"],
];

const tron = createBase58check(sha256);

/** A fresh deposit address in the network's own shape. */
export function depositAddressFor(network: string): string {
  if (EVM.includes(network)) return "0x" + randomBytes(20).toString("hex");
  if (network === "SOL") return base58.encode(randomBytes(32));
  if (network === "TRX") return tron.encode(Uint8Array.from([0x41, ...randomBytes(20)]));
  throw new Error(`fake FixedFloat: no address shape for ${network}`);
}

function defaultCcies(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = CATALOGUE.map(([code, coin, network, contract]) => ({
    code, coin, network, priority: 0, name: `${coin} (${network})`, recv: 1, send: 1, tag: null, logo: "", color: "#000000", contract,
  }));
  rows.push({ code: "USDTOP", coin: "USDT", network: "OP", priority: 0, name: "USDT (Optimism)", recv: 0, send: 0, tag: null, logo: "", color: "#000000", contract: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58" });
  rows.push({ code: "BTCLN", coin: "BTC", network: "LN", priority: 0, name: "Bitcoin (Lightning)", recv: 1, send: 1, tag: null, logo: "", color: "#000000", contract: null });
  return rows;
}

function defaultRates(): FakeRate[] {
  return CATALOGUE.map(([code, , , , out, min, max, tofee]) => ({ from: code, to: "BTCLN", out, min, max, tofee }));
}

function renderRates(rates: FakeRate[]): string {
  const items = rates.map((r) =>
    `\t<item>\n\t\t<from>${r.from}</from>\n\t\t<to>${r.to}</to>\n\t\t<in>1</in>\n\t\t<out>${r.out}</out>\n` +
    `\t\t<amount>241.04377808</amount>\n${r.tofee ? `\t\t<tofee>${r.tofee} ${r.to}</tofee>\n` : ""}` +
    `\t\t<minamount>${r.min} ${r.from}</minamount>\n\t\t<maxamount>${r.max} ${r.from}</maxamount>\n\t</item>`);
  return `<rates>\n${items.join("\n")}\n</rates>`;
}

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });

export async function fakeFixedFloat(opts: { apiKey?: string; secret?: string } = {}): Promise<FakeFf> {
  const nowSec = () => Math.floor(Date.now() / 1000);
  const ff = {
    apiKey: opts.apiKey ?? "fake-ff-key",
    secret: opts.secret ?? "fake-ff-secret",
    calls: [],
    ccies: defaultCcies(),
    rates: defaultRates(),
    ratesStatus: 200,
    orders: new Map<string, FakeOrder>(),
    windowSeconds: 900,
  } as unknown as FakeFf;

  const quote = (body: Record<string, any>) => {
    const row = ff.rates.find((r) => r.from === body.fromCcy && r.to === body.toCcy);
    const cur = ff.ccies.find((c) => c.code === body.fromCcy) as Record<string, any> | undefined;
    if (!row || !cur) return undefined;
    const out = Number(row.out);
    const toAmount = Number(body.amount);
    const fromAmount = Math.ceil((toAmount / out) * 1000) / 1000;
    const toSat = Math.round(toAmount * 1e8);
    const errors = toSat < Math.ceil(Number(row.min) * out * 1e8) ? ["LIMIT_MIN"]
      : toSat > Math.floor(Number(row.max) * out * 1e8) ? ["LIMIT_MAX"] : [];
    return { row, cur, out, toAmount, fromAmount, errors };
  };

  ff.price = (body) => {
    const q = quote(body);
    if (!q) return fail(301, "Unknown currency");
    return ok({
      from: { code: q.cur.code, network: q.cur.network, coin: q.cur.coin, amount: q.fromAmount, rate: q.out, precision: 8,
        min: Number(q.row.min), max: Number(q.row.max), usd: q.fromAmount, btc: Number((q.toAmount * 1.0268).toFixed(8)) },
      to: { code: "BTCLN", network: "LN", coin: "BTC", amount: q.toAmount, rate: 1 / q.out, precision: 8, min: 0.00001197, max: 0.17, usd: q.fromAmount * 0.97 },
      errors: q.errors,
    });
  };

  ff.create = (body) => {
    const q = quote(body);
    if (!q) return fail(301, "Unknown currency");
    if (typeof body.toAddress !== "string" || !body.toAddress.startsWith("ln")) return fail(304, "Invalid route, unable to find a path to destination");
    const at = nowSec();
    const order: FakeOrder = {
      id: randomBytes(3).toString("hex").toUpperCase(),
      token: randomBytes(20).toString("hex"),
      type: body.type,
      email: "",
      status: "NEW",
      time: { reg: at, start: null, finish: null, update: at, expiration: at + ff.windowSeconds, left: ff.windowSeconds },
      from: { code: q.cur.code, coin: q.cur.coin, network: q.cur.network, name: q.cur.name, alias: q.cur.code.toLowerCase(),
        amount: String(q.fromAmount), address: depositAddressFor(q.cur.network), tag: null, addressMix: "", reqConfirmations: 1, maxConfirmations: 1,
        tx: { id: null, amount: null, fee: null, ccyfee: null, timeReg: null, timeBlock: null, confirmations: null } },
      to: { code: "BTCLN", coin: "BTC", network: "LN", name: "Bitcoin (Lightning)", alias: "btcln", amount: q.toAmount.toFixed(8),
        address: body.toAddress, tag: null, addressMix: "", tx: { id: null, amount: null, fee: null, ccyfee: null, timeReg: null, timeBlock: null, confirmations: null } },
      back: { code: null, coin: null, network: null, name: null, alias: null, amount: null, address: null, tag: null, addressMix: null, tx: null },
      emergency: { status: [], choice: "NONE", repeat: false },
    };
    ff.orders.set(order.id, order);
    return ok(order);
  };

  ff.order = (body) => {
    const o = ff.orders.get(String(body.id));
    if (!o || o.token !== body.token) return fail(404, "Order not found");
    return ok(o);
  };

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/rates/fixed.xml") {
      res.writeHead(ff.ratesStatus, { "Content-Type": "application/xml" }).end(ff.ratesStatus === 200 ? renderRates(ff.rates) : "");
      return;
    }
    const match = /^\/api\/v2\/(\w+)$/.exec(req.url ?? "");
    if (req.method !== "POST" || !match) return send(404, fail(404, "Not found"));
    const raw = await readBody(req);
    const sign = createHmac("sha256", ff.secret).update(raw).digest("hex");
    if (req.headers["x-api-key"] !== ff.apiKey || req.headers["x-api-sign"] !== sign) return send(401, fail(401, "Invalid signature"));
    const method = match[1];
    const handler = { ccies: () => ok(ff.ccies), price: ff.price, create: ff.create, order: ff.order }[method];
    if (!handler) return send(404, fail(404, "Unknown method"));
    const body = raw ? JSON.parse(raw) : {};
    ff.calls.push({ method, weight: method === "create" ? 50 : 1, body });
    send(200, handler(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ff.baseUrl = `${origin}/api/v2`;
  ff.ratesUrl = `${origin}/rates/fixed.xml`;
  ff.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return ff;
}
