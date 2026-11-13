import type { Request } from "express";
import type { Repositories } from "../db/repositories/index.js";
import type { DomainRow } from "../types/index.js";
import { domainFromHost } from "./origin.js";
import { BadRequest, LnurlError } from "./errors.js";

/** Express types query values as string | string[] | ...; an array (`?a=1&a=2`)
 *  is never meaningful for our params — take them only when they're a string. */
export const strParam = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** LUD-12: what every payRequest advertises as `commentAllowed`, and every callback holds a payer to. */
export const COMMENT_ALLOWED = 140;

/** The payer's comment as the receiver will read it, or undefined for none. */
export const commentParam = (v: unknown): string | undefined => {
  const comment = strParam(v);
  if (!comment) return undefined;
  // Code points, not UTF-16 units: a wallet counting an emoji as one character must not be refused.
  if ([...comment].length > COMMENT_ALLOWED) throw new LnurlError(`Comment must be at most ${COMMENT_ALLOWED} characters`);
  return comment;
};

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
