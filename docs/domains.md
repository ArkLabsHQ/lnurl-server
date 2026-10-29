# Lightning address domains

One server can serve addresses on several domains. It picks the domain from the `Host` header of each payer request, ignoring any port. A domain is served wherever requests for its payer paths reach port 3000 with that `Host` intact. `BASE_URL` remains the server's own address, for wallets and the admin.

## What must reach the server

| Path on the address's domain | Called by |
| --- | --- |
| `/.well-known/lnurlp/<username>` | a payer resolving `<username>@<domain>` |
| `/.well-known/lnurlp/<username>/callback` | that payer, for an invoice or a destination |
| `/lnurl/<session id>` and `/lnurl/<session id>/callback` | a payer of a nameless address (`session` mode); the id is 32 hex characters |

These stay on `BASE_URL` and need no route on the domain:

- the wallet API (`/lnurl/address`, `/lnurl/domain`, and the others under `/lnurl/`);
- `verify` and `verifyBatch` URLs;
- live-session LNURLs.

The server builds each callback as `<protocol>://<domain>`, using the protocol of the payer's request as `TRUST_PROXY` lets it read. The hop in front of the server must report `X-Forwarded-Proto: https`. Otherwise callbacks start with `http://`.

## Setup

1. **Register the domain.** Use the admin UI's Domains tab, or `POST /admin/api/domains` with, for example, `{ "domain": "pay.example", "allocationModes": ["random", "admin", "session"] }`. The server answers an unregistered or disabled domain with `Unknown or disabled domain`.
2. **Route the payer paths to port 3000, keeping `Host`.** Pick the case that matches the domain:
   - **A domain used only for addresses:** point its DNS at the server's reverse proxy. Add a route for `Host(pay.example)` there, with a certificate for that name.
   - **A domain that already serves a site:** the site's web server forwards the paths above to the server with the original `Host`. With nginx:

     ```nginx
     location ~ "^/(\.well-known/lnurlp/[^/]+|lnurl/[0-9a-f]{32})(/callback)?$" {
       proxy_pass http://lnurl-server:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
     ```

     Set `TRUST_PROXY` to the number of proxies between the payer and the server. The server then reads `X-Forwarded-Proto` and the payer's IP from the right hop.

     The `location` matches only the payer paths, since the rest of `/lnurl/` is the wallet API; nginx needs the quotes around a regular expression with braces. If the site holds secrets, as a wallet does, also:
     - drop `Authorization` and `Cookie` before forwarding;
     - serve the answers as `application/json` with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, so nothing from upstream runs or sets cookies on that origin.
   - **A domain on Cloudflare, served by Pages or a Worker:** a zone Worker on the routes `pay.example/.well-known/lnurlp/*` and `pay.example/lnurl/*` fetches with `cf: { resolveOverride: "<origin record>" }`. Zone routes take precedence over Pages.
     - The origin record is a proxied hostname in the same zone, such as an A record for the server or a CNAME to it. The request keeps `Host: pay.example`.
     - A Pages Function cannot do this. Cloudflare ignores its override, so its fetch loops back to Pages.
     - Cloudflare also ignores the override when the hostname is in another zone, or does not exist.

     The Worker, with the variable `LNURL_ORIGIN` set on it to the origin record's hostname:

     ```js
     const FORWARDED = 'x-arkade-lnurl-forwarded'
     const LNURL_PATH = /^\/(\.well-known\/lnurlp\/[^/]+|lnurl\/[0-9a-f]{32})(\/callback)?$/
     const SAFE_HEADERS = {
       'Content-Type': 'application/json',
       'X-Content-Type-Options': 'nosniff',
       'Content-Security-Policy': "default-src 'none'; sandbox",
       'X-Frame-Options': 'DENY',
       'Access-Control-Allow-Origin': '*',
     }
     const refuse = (status, reason, headers = {}) =>
       new Response(JSON.stringify({ status: 'ERROR', reason }), { status, headers: { ...SAFE_HEADERS, ...headers } })

     export default {
       async fetch(request, env) {
         const origin = env.LNURL_ORIGIN
         if (!origin || !LNURL_PATH.test(new URL(request.url).pathname)) return refuse(404, 'Not found')
         if (request.method !== 'GET') return refuse(405, 'Method not allowed', { Allow: 'GET' })
         // 508: Cloudflare can replace a 502 with its own error page, hiding the reason.
         if (request.headers.has(FORWARDED)) return refuse(508, 'LNURL origin unreachable')
         const forwarded = new Request(request)
         forwarded.headers.set(FORWARDED, '1')
         forwarded.headers.delete('authorization')
         forwarded.headers.delete('cookie')
         const upstream = await fetch(forwarded, { cf: { resolveOverride: origin } })
         return new Response(upstream.body, { status: upstream.status, headers: SAFE_HEADERS })
       },
     }
     ```

     It forwards only a `GET` of the payer paths, without `Authorization` or `Cookie`, and serves every answer as JSON that cannot run, frame or set cookies on the domain.

     The server's route for the domain needs a certificate for `pay.example`. Use a Cloudflare Origin CA certificate with the zone's SSL mode at "Full (strict)". A Let's Encrypt HTTP-01 challenge cannot reach the server while the domain's traffic goes to Pages.

     arkade.money is served this way, in front of the arkade-os/wallet Pages app.
3. **Point wallets at the domain.** Use `arkadeLnurl({ baseUrl: "https://lnurl.example.com", domain: "pay.example" })`. `@arkade-os/lnurl-client` 0.9.2 and later build the domain's LNURLs on `https://pay.example`. Earlier versions built them on `baseUrl`, where the server looks the address up in the wrong domain.

## Check

- `curl -s https://pay.example/.well-known/lnurlp/<username>` returns `"tag":"payRequest"`, and its `callback` starts with `https://pay.example/.well-known/lnurlp/`.
- For a nameless address, `curl -s https://pay.example/lnurl/<session id>` returns the same, with a callback under `https://pay.example/lnurl/`.

| Symptom | Cause |
| --- | --- |
| HTML instead of JSON | The domain's own site answered: the path is not routed to the server. |
| `Unknown or disabled domain` | The domain is not registered or is disabled, or `Host` was rewritten on the way. |
| `This LNURL is no longer active` from `/lnurl/<session id>` | The request reached the server under another `Host`. From a wallet, this is often a client older than 0.9.2. |
| A callback that starts with `http://` | The hop in front of the server reported plain HTTP. Check `X-Forwarded-Proto` and `TRUST_PROXY`. |
| `404 Not found` from the Worker | `LNURL_ORIGIN` is not set on the Worker. |
| Cloudflare `Error 1016 Origin DNS error`, the Worker's `508`, or a bare `error code: 502` | Cloudflare ignored the override, so the request went back to the domain itself. Check the override hostname, character for character, and that a zone Worker serves the routes, not a Pages Function. |
| `401 Unauthorized` on a lookup | The proxy's route for the domain carries an authentication middleware, for example one meant for the admin. A proxy in front, such as a Worker serving only safe headers, can drop its `WWW-Authenticate`; `curl -k --resolve pay.example:443:<server IP>` asks the server directly. |
