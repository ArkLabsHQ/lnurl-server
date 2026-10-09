// FixedFloat rails as LUD-XX paymentOptions. The shape is the one the BTCPay plugin's
// strict parser already takes (TokenOption.cs): `type` is the asset's CAIP-2 namespace,
// `unit` names a units[] code, and every option sharing a code shares its decimals.

import type { PaymentOption } from "../../payment-options.js";
import type { Unit } from "../../quote-provider.js";
import type { Bounds, FfRailCaps } from "../../rails.js";
import type { FfRail } from "./rates.js";
import { FF_UNITS, namespaceOf, type TokenUnitCode } from "./catalogue.js";

/** FixedFloat's market for one rail, narrowed by what the corridor and the envelope allow,
 *  in whole sats. Undefined when they do not overlap: an unsatisfiable option is omitted. */
export function ffOptionBounds(rail: FfRail, corridor: Bounds): Bounds | undefined {
  const min = Math.ceil(Math.max(rail.minSat * 1000, corridor.min) / 1000) * 1000;
  const max = Math.floor(Math.min(rail.maxSat * 1000, corridor.max) / 1000) * 1000;
  return min <= max ? { min, max } : undefined;
}

/** Bounds are always stated: a token rail's market has nothing to do with the top-level pair. */
export function ffPaymentOptions(caps: FfRailCaps, corridor: Bounds, available: boolean): PaymentOption[] {
  return caps.rails.flatMap((rail): PaymentOption[] => {
    const bounds = ffOptionBounds(rail, corridor);
    if (!bounds) return [];
    return [{
      id: rail.optionId,
      type: namespaceOf(rail.asset),
      asset: rail.asset,
      unit: rail.unit,
      provider: caps.provider,
      verifiable: true,
      ...(available ? {} : { available: false }),
      minSendable: bounds.min,
      maxSendable: bounds.max,
    }];
  });
}

/** units[] for a payRequest: `units` as given, plus each token unit an option names. A
 *  token option whose code `units` already defines with other decimals is dropped. */
export function withTokenUnits(options: PaymentOption[], units: Unit[]): { options: PaymentOption[]; units: Unit[] } {
  const out = [...units];
  const kept = options.filter((option) => {
    const token = option.unit ? FF_UNITS[option.unit as TokenUnitCode] : undefined;
    if (!token) return true;
    const existing = out.find((u) => u.code.toUpperCase() === token.code);
    if (existing) return existing.decimals === token.decimals;
    out.push({ ...token });
    return true;
  });
  return { options: kept, units: out };
}
