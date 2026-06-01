import type { Request } from "express";

/** Lowercase host without port, or null if absent. Handles bracketed IPv6 literals. */
export function domainFromHost(host: string | undefined): string | null {
  if (!host) return null;
  if (host.startsWith("[")) {            // IPv6 literal: [::1] or [::1]:port
    const close = host.indexOf("]");
    return close === -1 ? null : host.slice(1, close).toLowerCase();
  }
  return host.split(":")[0]!.toLowerCase();
}

/** External origin (scheme://host) for the request.
 *  The SCHEME reflects X-Forwarded-Proto when `trust proxy` is enabled;
 *  the host always comes from the raw `Host` header. */
export function originFromRequest(req: Pick<Request, "protocol" | "get">): string {
  return `${req.protocol}://${req.get("host")}`;
}
