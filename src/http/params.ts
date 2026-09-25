import type { Request } from "express";
import type { Repositories } from "../db/repositories/index.js";
import type { DomainRow } from "../types/index.js";
import { domainFromHost } from "./origin.js";
import { BadRequest } from "./errors.js";

/** Express types query values as string | string[] | ...; an array (`?a=1&a=2`)
 *  is never meaningful for our params — take them only when they're a string. */
export const strParam = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A row id from the path. `Number()` alone turns "abc" into NaN, which the driver then matches against nothing. */
export const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) throw new BadRequest("id must be a positive integer");
  return id;
};

/** A millisat amount written as a plain integer. `Number()` alone would take "1e3",
 *  "0x3e8", " 1000 " and "1000.0"; the sign is left to the caller's range check. */
export const msatParam = (v: unknown): number | undefined => {
  if (typeof v !== "string" || !/^-?\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
};

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
