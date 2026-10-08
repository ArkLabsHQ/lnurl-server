import type { Db } from "../../db/connection.js";
import type { FixedFloatConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { FfOrderStore } from "../../ff-order-store.js";
import { startCatchUpLoop } from "../../workers/catch-up-loop.js";
import { ffReferenceOnSettle, startFfOrderPoller } from "../../workers/ff-order-poller.js";
import { FfBudget, ffClient, ffHttpTransport, type FfTransport } from "./client.js";
import { ffRates, ffRatesXml } from "./rates.js";
import { DepositWindow, FIXEDFLOAT, SIMULATED, type FixedFloatDeps } from "./provider.js";
import { FF_ASSETS } from "./catalogue.js";
import { SIM_ASSETS, simulatedRatesXml, simulatedTransport } from "./simulate.js";

const ORDER_POLL_MS = 60_000;

export interface StartedFixedFloat {
  deps: FixedFloatDeps;
  /** For the offline poller: references a settled token deposit by the payer's own txid. */
  onSettled: (paymentHash: string) => Promise<void>;
  stop(): void;
}

/** The token-deposit rail: one request budget shared by every FixedFloat call, the rates
 *  refresh, and the order poller. Call only after assertFixedFloatNetwork. */
export function startFixedFloat(opts: { config: FixedFloatConfig; db: Db; ttlMs: number; logger: Logger }): StartedFixedFloat {
  const { config, db, ttlMs, logger } = opts;
  const orders = new FfOrderStore(db, ttlMs);
  const simulated = config.mode === "simulate";
  let transport: FfTransport;
  if (simulated) {
    transport = simulatedTransport({ orders: { find: (id) => {
      const order = orders.byOrderId(id);
      return order ? { order, settled: orders.isSettled(id) } : undefined;
    } } });
  } else if (config.auth) {
    transport = ffHttpTransport({ baseUrl: config.baseUrl, auth: config.auth });
  } else {
    throw new Error("startFixedFloat: live mode needs FIXEDFLOAT_API_KEY and FIXEDFLOAT_API_SECRET");
  }
  const provider = simulated ? SIMULATED : FIXEDFLOAT;
  const client = ffClient({
    transport,
    budget: new FfBudget(),
    ...(config.refcode ? { refcode: config.refcode } : {}),
    ...(config.afftax !== undefined ? { afftax: config.afftax } : {}),
  });
  const rates = ffRates({
    client,
    fetchRatesXml: simulated ? async () => simulatedRatesXml() : ffRatesXml(config.ratesUrl),
    idPrefix: provider.idPrefix,
    assets: simulated ? SIM_ASSETS : FF_ASSETS,
    ...(config.allow ? { allow: config.allow } : {}),
    deny: config.deny,
    staleAfterMs: config.refreshMs * 3,
    logger,
  });
  const refresh = startCatchUpLoop({ pass: () => rates.refresh(), intervalMs: config.refreshMs, onError: (error) => logger.warn("ff_rates_stale", { error }), immediate: true });
  const poller = startFfOrderPoller({ orders, client, logger, intervalMs: ORDER_POLL_MS });
  return {
    deps: {
      provider, rates, client, orders, window: new DepositWindow(config.windowSeconds),
      settleMarginSeconds: config.settleMarginSeconds, maxOpenOrders: config.maxOpenOrders,
    },
    onSettled: ffReferenceOnSettle({ orders, client, logger }),
    stop: () => { refresh.stop(); poller.stop(); },
  };
}
