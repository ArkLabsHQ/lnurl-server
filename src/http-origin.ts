/** Lowercase host without port, or null if absent. Handles bracketed IPv6 literals. */
export function domainFromHost(host: string | undefined): string | null {
  if (!host) return null;
  if (host.startsWith("[")) {            // IPv6 literal: [::1] or [::1]:port
    const close = host.indexOf("]");
    return close === -1 ? null : host.slice(1, close).toLowerCase();
  }
  return host.split(":")[0]!.toLowerCase();
}
