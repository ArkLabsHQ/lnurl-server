// A fetch that refuses private, loopback, link-local and CGNAT hosts, for URLs typed
// into the admin UI. Ported from intent-solver solver-core price/guardedFetch.ts. The
// check runs inside the socket's DNS lookup, so a rebinding answer cannot slip past
// it, and again on every redirect hop.

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([204, 205, 304]);
const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "" || host === "::" || host === "::1") return true;
  if (host.includes(":")) {
    if (/^fe[89a-f][0-9a-f]:/.test(host)) return true; // fe80::/9
    if (host.startsWith("fc") || host.startsWith("fd")) return true; // fc00::/7
    const v6Mapped = /^::ffff:(.+)$/.exec(host);
    if (!v6Mapped) return false;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6Mapped[1]!);
    if (!hex) return isPrivateHost(v6Mapped[1]!);
    const [hi, lo] = [Number.parseInt(hex[1]!, 16), Number.parseInt(hex[2]!, 16)];
    return isPrivateHost([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join("."));
  }
  const v4 = V4.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true; // >= 224: multicast, reserved, broadcast
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 CGNAT
  return a === 192 && b === 168;
}

const refusingLookup =
  (resolve: typeof dnsLookup, isPrivate: (address: string) => boolean): LookupFunction =>
  (hostname, options, callback) =>
    resolve(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error, "", 0);
      const blocked = addresses.find((a) => isPrivate(a.address));
      if (blocked) return callback(new Error(`feed host ${hostname} resolves to private address ${blocked.address}`), "", 0);
      if (options.all) return (callback as (e: null, a: LookupAddress[]) => void)(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });

export function createGuardedFetch(deps: { lookup?: typeof dnsLookup; isPrivate?: (address: string) => boolean } = {}): typeof globalThis.fetch {
  const isPrivate = deps.isPrivate ?? isPrivateHost;
  const lookup = refusingLookup(deps.lookup ?? dnsLookup, isPrivate);

  const get = (url: URL, init?: RequestInit): Promise<http.IncomingMessage> =>
    new Promise((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      const request = client.request(
        url,
        { method: "GET", headers: init?.headers as http.OutgoingHttpHeaders | undefined, signal: init?.signal ?? undefined, lookup },
        resolve,
      );
      request.on("error", reject).end();
    });

  return (async (input: string | URL | Request, init?: RequestInit) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`feed ${String(input)}: refused a hop to ${url.protocol}`);
      // An IP literal never reaches `lookup`: Node connects to it directly.
      if (isPrivate(url.hostname)) throw new Error(`feed ${String(input)}: refused private host ${url.hostname}`);
      const response = await get(url, init);
      const status = response.statusCode ?? 502;
      const location = response.headers.location;
      if (REDIRECTS.has(status) && location) {
        response.resume();
        if (hop >= MAX_REDIRECTS) throw new Error(`feed ${String(input)}: more than ${MAX_REDIRECTS} redirects`);
        url = new URL(location, url);
        continue;
      }
      const body = NULL_BODY.has(status) ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
      return new Response(body, { status, statusText: response.statusMessage ?? "" });
    }
  }) as typeof globalThis.fetch;
}
