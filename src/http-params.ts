import type { Request } from "express";
import type { Repositories } from "./db/repositories/index.js";
import type { DomainRow } from "./types/index.js";
import { domainFromHost } from "./http-origin.js";

/** Express types query values as string | string[] | ...; an array (`?a=1&a=2`)
 *  is never meaningful for our params — take them only when they're a string. */
export const strParam = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export const bearerToken = (req: Request): string => {
  const auth = req.headers.authorization;
  return auth?.startsWith("Bearer ") ? auth.slice(7) : "";
};

export const originOf = (req: Request, domain: DomainRow): string => `${req.protocol}://${domain.domain}`;

/** The configured domain a host-ish value names, enabled or not. */
export const domainFor = (repos: Repositories, host: string | undefined): DomainRow | undefined => {
  const name = domainFromHost(host);
  return name ? repos.domains.getByDomain(name) : undefined;
};
