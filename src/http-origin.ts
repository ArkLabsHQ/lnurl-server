import type { Request } from "express";

/** Lowercase host without port, or null if absent. */
export function domainFromHost(host: string | undefined): string | null {
  if (!host) return null;
  return host.split(":")[0]!.toLowerCase();
}

/** External origin (scheme://host) for the request. Requires `app.set('trust proxy', ...)`
 *  so `protocol` and `Host` reflect X-Forwarded-* when behind a proxy. */
export function originFromRequest(req: Pick<Request, "protocol" | "get">): string {
  return `${req.protocol}://${req.get("host")}`;
}
