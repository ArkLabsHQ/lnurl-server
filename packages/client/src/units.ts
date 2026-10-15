/** `amount` in a unit's smallest denomination, as a decimal: ("500", 2) reads "5.00". */
export function formatUnitAmount(amount: string | number, decimals: number): string {
  const digits = String(amount).padStart(decimals + 1, "0");
  return decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
}

/** A typed decimal in a unit's smallest denomination: ("5.5", 2) is 550. Undefined for
 *  anything that is not a plain positive decimal, or has more places than the unit. */
export function parseUnitAmount(text: string, decimals: number): number | undefined {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!match || (match[1] === "" && !match[2])) return undefined;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return undefined;
  const amount = Number(`${match[1]}${fraction.padEnd(decimals, "0")}`);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}
