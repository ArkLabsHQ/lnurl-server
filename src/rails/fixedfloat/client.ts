// FixedFloat API v2: one HTTP seam, one signer, one weighted budget.
// https://ff.io/api — every call is a signed POST answering { code, msg, data }.

import { createHmac } from "node:crypto";

export type FfMethod = "ccies" | "price" | "create" | "order";

/** FixedFloat's documented costs: 250 units a minute per key, create 50, the rest 1. */
export const FF_LIMIT_PER_MINUTE = 250;
export const FF_CREATE_WEIGHT = 50;
const FF_CALL_WEIGHT = 1;

export class FfApiError extends Error {
  constructor(readonly method: FfMethod, readonly code: number | undefined, detail: string) {
    super(`FixedFloat ${method} failed${code === undefined ? "" : ` (code ${code})`}: ${detail}`);
    this.name = "FfApiError";
  }
}

export class FfBudgetError extends Error {
  constructor(readonly method: FfMethod) {
    super(`FixedFloat request budget exhausted (${method})`);
    this.name = "FfBudgetError";
  }
}

/** The credentials, closed over so no config object or error path can hold them. */
export interface FfAuth {
  headers(body: string): Record<string, string>;
  /** Strips the credentials from text FixedFloat sent back, should it echo them. */
  redact(text: string): string;
}

export function ffAuth(apiKey: string, apiSecret: string): FfAuth {
  return {
    headers: (body) => ({ "X-API-KEY": apiKey, "X-API-SIGN": createHmac("sha256", apiSecret).update(body).digest("hex") }),
    redact: (text) => [apiKey, apiSecret].reduce((t, secret) => (secret ? t.split(secret).join("[REDACTED]") : t), text),
  };
}

export interface FfTransport {
  /** The `data` of a `code: 0` answer; anything else throws {@link FfApiError}. */
  call(method: FfMethod, data: object): Promise<unknown>;
}

export function ffHttpTransport(cfg: { baseUrl: string; auth: FfAuth; timeoutMs?: number }): FfTransport {
  return {
    async call(method, data) {
      // The signature covers the bytes sent, so the body is serialised exactly once.
      const body = JSON.stringify(data);
      let res: Response;
      try {
        res = await fetch(`${cfg.baseUrl}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=UTF-8", ...cfg.auth.headers(body) },
          body,
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
        });
      } catch (err) {
        throw new FfApiError(method, undefined, cfg.auth.redact(err instanceof Error ? err.message : "request failed"));
      }
      const json = (await res.json().catch(() => undefined)) as { code?: unknown; msg?: unknown; data?: unknown } | undefined;
      if (!json || json.code !== 0) {
        const code = typeof json?.code === "number" ? json.code : undefined;
        throw new FfApiError(method, code, cfg.auth.redact(typeof json?.msg === "string" ? json.msg : `HTTP ${res.status}`));
      }
      return json.data;
    },
  };
}

/** A sliding one-minute window over FixedFloat's weights, shared by every call in the process. */
export class FfBudget {
  private spent: { at: number; weight: number }[] = [];

  constructor(private limit = FF_LIMIT_PER_MINUTE, private windowMs = 60_000, private now: () => number = Date.now) {}

  /** Spends now or refuses; it never waits, since a queued payer would be handed a stale quote.
   *  The returned function hands the units back for a call that was never made. */
  take(weight: number): (() => void) | undefined {
    if (this.used() + weight > this.limit) return undefined;
    const entry = { at: this.now(), weight };
    this.spent.push(entry);
    return () => { this.spent = this.spent.filter((s) => s !== entry); };
  }

  used(): number {
    const t = this.now();
    this.spent = this.spent.filter((s) => t - s.at < this.windowMs);
    return this.spent.reduce((n, s) => n + s.weight, 0);
  }
}

export interface FfCurrency {
  code: string;
  coin: string;
  network: string;
  recv: boolean;
  send: boolean;
  tag: string | null;
  contract: string | null;
}

/** Every quote is fixed-rate, `direction: "to"`, into BTCLN: the corridor's invoice names exact sats. */
export interface FfAmountRequest { fromCcy: string; toSat: number }
export interface FfCreateRequest extends FfAmountRequest { toAddress: string }

export interface FfPrice {
  fromCode: string;
  fromAmount: string;
  /** FixedFloat's own BTC valuation of `fromAmount`, when it sends one. */
  fromBtc?: string;
  toAmount: string;
  errors: string[];
}

export interface FfOrder {
  id: string;
  token: string;
  type: string;
  status: string;
  /** Unix seconds; undefined when the answer states no usable deadline. */
  expiresAt: number | undefined;
  from: { code: string; amount: string; address: string; tag: string | null; txid: string | null };
  to: { code: string; amount: string };
  emergency: { status: string[]; choice: string } | null;
}

export interface FfReservation { release(): void }

export interface FfClient {
  ccies(): Promise<FfCurrency[]>;
  price(req: FfAmountRequest): Promise<FfPrice>;
  /** Takes create's 50 units before anything irreversible happens; undefined when they are not there. */
  reserveCreate(): FfReservation | undefined;
  create(req: FfCreateRequest, reservation: FfReservation): Promise<FfOrder>;
  order(id: string, token: string): Promise<FfOrder>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const flag = (v: unknown): boolean => v === true || v === 1;

/** A plain decimal string, or undefined: an exponent or a non-finite number is refused, not coerced. */
export function decimalString(v: unknown): string | undefined {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v : undefined;
  return s !== undefined && /^\d+(\.\d+)?$/.test(s) ? s : undefined;
}

function btc(sats: number): number {
  // Below 100 sats JSON would print an exponent, which no FixedFloat minimum gets near anyway.
  if (!Number.isSafeInteger(sats) || sats < 100) throw new RangeError(`unquotable amount: ${sats} sats`);
  return sats / 1e8;
}

function malformed(method: FfMethod, what: string): FfApiError {
  return new FfApiError(method, undefined, `malformed answer (${what})`);
}

function parseOrder(method: FfMethod, data: unknown, nowSec: number): FfOrder {
  const d = (data ?? {}) as Record<string, any>;
  const from = (d.from ?? {}) as Record<string, any>;
  const to = (d.to ?? {}) as Record<string, any>;
  const id = str(d.id);
  const token = str(d.token);
  const fromAmount = decimalString(from.amount);
  const toAmount = decimalString(to.amount);
  const address = str(from.address);
  if (!id || !token || !str(d.status) || !fromAmount || !toAmount || !address || !str(from.code) || !str(to.code)) {
    throw malformed(method, "order fields");
  }
  const expiration = Number.isFinite(d.time?.expiration) ? Number(d.time.expiration) : undefined;
  const left = Number.isFinite(d.time?.left) ? nowSec + Number(d.time.left) : undefined;
  const deadlines = [expiration, left].filter((v): v is number => v !== undefined);
  const emergency = d.emergency && Array.isArray(d.emergency.status) && d.emergency.status.length > 0
    ? { status: d.emergency.status.filter((s: unknown): s is string => typeof s === "string"), choice: String(d.emergency.choice ?? "NONE") }
    : null;
  return {
    id,
    token,
    type: String(d.type ?? ""),
    status: d.status,
    expiresAt: deadlines.length ? Math.min(...deadlines) : undefined,
    from: { code: from.code, amount: fromAmount, address, tag: str(from.tag) ?? null, txid: str(from.tx?.id) ?? null },
    to: { code: to.code, amount: toAmount },
    emergency,
  };
}

export function ffClient(cfg: {
  transport: FfTransport;
  budget: FfBudget;
  refcode?: string;
  afftax?: number;
  now?: () => number;
}): FfClient {
  const nowSec = () => Math.floor((cfg.now ?? Date.now)() / 1000);
  const affiliate = { ...(cfg.refcode ? { refcode: cfg.refcode } : {}), ...(cfg.afftax !== undefined ? { afftax: cfg.afftax } : {}) };
  const call = (method: FfMethod, data: object): Promise<unknown> => {
    if (!cfg.budget.take(FF_CALL_WEIGHT)) return Promise.reject(new FfBudgetError(method));
    return cfg.transport.call(method, data);
  };
  const quoteBody = (req: FfAmountRequest) => ({ type: "fixed", fromCcy: req.fromCcy, toCcy: "BTCLN", direction: "to", amount: btc(req.toSat), ...affiliate });
  const spent = new WeakSet<FfReservation>();

  return {
    async ccies() {
      const data = await call("ccies", {});
      if (!Array.isArray(data)) throw malformed("ccies", "not a list");
      return data.flatMap((e: Record<string, unknown>) => {
        const code = str(e?.code);
        const coin = str(e?.coin);
        const network = str(e?.network);
        if (!code || !coin || !network) return [];
        return [{ code, coin, network, recv: flag(e.recv), send: flag(e.send), tag: str(e.tag) ?? null, contract: str(e.contract) ?? null }];
      });
    },

    async price(req) {
      const d = (await call("price", quoteBody(req))) as Record<string, any> | null;
      const fromAmount = decimalString(d?.from?.amount);
      const toAmount = decimalString(d?.to?.amount);
      if (!d || !str(d.from?.code) || !fromAmount || !toAmount) throw malformed("price", "amounts");
      const fromBtc = decimalString(d.from.btc);
      return {
        fromCode: d.from.code,
        fromAmount,
        ...(fromBtc ? { fromBtc } : {}),
        toAmount,
        errors: Array.isArray(d.errors) ? d.errors.filter((e: unknown): e is string => typeof e === "string") : [],
      };
    },

    reserveCreate() {
      const refund = cfg.budget.take(FF_CREATE_WEIGHT);
      if (!refund) return undefined;
      const reservation: FfReservation = { release: () => { if (!spent.has(reservation)) { spent.add(reservation); refund(); } } };
      return reservation;
    },

    async create(req, reservation) {
      if (spent.has(reservation)) throw new Error("FixedFloat create reservation already used or released");
      spent.add(reservation);
      const data = await cfg.transport.call("create", { ...quoteBody(req), toAddress: req.toAddress });
      return parseOrder("create", data, nowSec());
    },

    async order(id, token) {
      return parseOrder("order", await call("order", { id, token }), nowSec());
    },
  };
}
