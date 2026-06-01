import { bech32 } from "@scure/base";

export function encodeLnurl(url: string): string {
  const words = bech32.toWords(new TextEncoder().encode(url));
  return bech32.encode("lnurl", words, 1023).toUpperCase();
}
