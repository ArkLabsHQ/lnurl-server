// The wallet deeplink for a token deposit, built exactly as the BTCPay plugin builds it
// (TokenNamespaces.cs), so a payer sees the same instruction from either consumer.

const CAIP19 = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})\/([-a-z0-9]{3,8}):([-.%a-zA-Z0-9]{1,128})$/;

/** Base units as a decimal in whole tokens, exact (TokenAmount.Format). */
export function formatUnits(baseUnits: string, decimals: number): string {
  const digits = baseUnits.replace(/^0+/, "").padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/** EIP-681 for eip155, Solana Pay for solana; undefined for tron, which neither consumer
 *  has a URI for, so its answer carries the address alone. */
export function tokenPaymentUri(asset: string, to: string, baseUnits: string, decimals: number): string | undefined {
  const match = CAIP19.exec(asset);
  if (!match) return undefined;
  const [, namespace, chainReference, , reference] = match;
  if (namespace === "eip155") return `ethereum:${reference}@${chainReference}/transfer?address=${to}&uint256=${baseUnits}`;
  if (namespace === "solana") return `solana:${to}?amount=${formatUnits(baseUnits, decimals)}&spl-token=${reference}`;
  return undefined;
}
