import type { Db } from "../../db/connection.js";
import type { FixedFloatConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { FfOrderStore } from "../../ff-order-store.js";
import { startCatchUpLoop } from "../../workers/catch-up-loop.js";
import { ffReferenceOnSettle, startFfOrderPoller } from "../../workers/ff-order-poller.js";
import { FfBudget, ffClient, ffHttpTransport } from "./client.js";
import { ffRates, ffRatesXml } from "./rates.js";
import { DepositWindow, FIXEDFLOAT, type FixedFloatDeps } from "./provider.js";

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
  if (config.mode !== "live" || !config.auth) throw new Error("startFixedFloat: the simulator is not wired yet");
  const orders = new FfOrderStore(db, ttlMs);
  const client = ffClient({
    transport: ffHttpTransport({ baseUrl: config.baseUrl, auth: config.auth }),
    budget: new FfBudget(),
    ...(config.refcode ? { refcode: config.refcode } : {}),
    ...(config.afftax !== undefined ? { afftax: config.afftax } : {}),
  });
  const rates = ffRates({
    client,
    fetchRatesXml: ffRatesXml(config.ratesUrl),
    idPrefix: FIXEDFLOAT.idPrefix,
    ...(config.allow ? { allow: config.allow } : {}),
    deny: config.deny,
    staleAfterMs: config.refreshMs * 3,
    logger,
  });
  const refresh = startCatchUpLoop({ pass: () => rates.refresh(), intervalMs: config.refreshMs, onError: (error) => logger.warn("ff_rates_stale", { error }), immediate: true });
  const poller = startFfOrderPoller({ orders, client, logger, intervalMs: ORDER_POLL_MS });
  return {
    deps: {
      provider: FIXEDFLOAT, rates, client, orders, window: new DepositWindow(config.windowSeconds),
      settleMarginSeconds: config.settleMarginSeconds, maxOpenOrders: config.maxOpenOrders,
    },
    onSettled: ffReferenceOnSettle({ orders, client, logger }),
    stop: () => { refresh.stop(); poller.stop(); },
  };
}
