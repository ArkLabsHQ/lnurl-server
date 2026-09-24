// Drives every LNURL feature the wallet uses, through the wallet's own surface
// rather than the client's. test/client-contract.test.ts already pins the
// client/server wire; what this covers is the layer above it — onboarding,
// rail selection through the router, and the address lifecycle — where the
// wallet's own wiring is what can be wrong.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { ArkAddress, MnemonicIdentity, type PaymentRail, type RouteQuote } from "@arkade-os/sdk";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { createLnurlClient, LnurlError } from "@arkade-os/lnurl-client";
import { LNURL_ARKADE_RAIL, LNURL_LIGHTNING_RAIL, lnurlRails } from "@arkade-os/lnurl-client/arkade";
import { createServer } from "../../../src/server.js";
import { openDb, type Db } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { createRepositories, type Repositories } from "../../../src/db/repositories/index.js";
import { AddressService } from "../../../src/address-service.js";
import { RateLimiter } from "../../../src/rate-limit.js";
import type { ArkadeSigner } from "@arkade-os/lnurl-client/arkade";
import { claimOrAdopt, receiverAt } from "../src/lnurl.js";

const DOMAIN = "127.0.0.1";
const CONFIG = { port: 0, minSendable: 1_000, maxSendable: 100_000_000, invoiceTimeoutMs: 3_000 };

const arkadeAddress = () =>
  new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), "tark").encode();
const newIdentity = () => MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist));

/** The old `api.onboard` shape over the facade, plus the token tests need. */
const ownedUsername = (token: string) =>
  createLnurlClient({ baseUrl }).listAddresses(token)
    .then((mine) => mine.find((a) => a.status === "active")?.username ?? mine[0]?.username);
/** Takes the token explicitly: one of these tests passes a stranger's, which
 *  the facade's own-token API cannot express. */
const payments = (token: string, username: string) =>
  createLnurlClient({ baseUrl }).listPayments(token, username, { domain: DOMAIN }).then((page) => page.payments);
const tokenFor = (identity: ArkadeSigner) =>
  receiverAt(baseUrl, DOMAIN, { identity, arkadeAddress: arkadeAddress() }).token();

const onboard = async (identity: ArkadeSigner, arkadeAddress: string, username: string) => {
  const rx = receiverAt(baseUrl, DOMAIN, { identity, arkadeAddress });
  const claimed = await rx.claim({ username });
  return { username: claimed.handle, lightningAddress: claimed.lightningAddress, token: await rx.token() };
};


let db: Db;
let repos: Repositories;
let server: http.Server;
let baseUrl: string;

/** The server builds payRequest callbacks and LNURLs from the registered domain
 *  with no port, because a real LUD-16 address lives on 443 (src/server.ts). The
 *  test server is http on an ephemeral port, so every such URL is redirected
 *  back to it — the only hop faked anywhere in this file. */
const toTestUrl = (u: string) => u.replace(/^https?:\/\/127\.0\.0\.1(?!:\d)/, baseUrl);

/** Fetched directly, for the same reason. */
async function payRequestFor(username: string): Promise<Record<string, any>> {
  const res = await fetch(`${baseUrl}/.well-known/lnurlp/${username}`);
  return res.json() as Promise<Record<string, any>>;
}

/** Stands in for arkRail / solverLightningRail, recording what it was handed. */
function fakeRail(id: string): PaymentRail & { seen: { raw: string; amount?: number }[] } {
  const seen: { raw: string; amount?: number }[] = [];
  return {
    id,
    seen,
    match: () => true,
    quote: async (req) => {
      seen.push({ raw: req.raw, amount: req.amount });
      return { railId: id, amount: req.amount ?? 0, fee: 0, total: req.amount ?? 0, send: async () => ({}) } as unknown as RouteQuote;
    },
  };
}

beforeEach(async () => {
  db = openDb(":memory:");
  runMigrations(db);
  repos = createRepositories(db);
  repos.domains.create({ domain: DOMAIN, allocationModes: ["self", "random"] });
  const addressService = new AddressService(repos, randomBytes(32));
  server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, DOMAIN, () => resolve()));
  const { port } = server.address() as { port: number };
  baseUrl = `http://${DOMAIN}:${port}`;
  server.on("request", createServer(
    { ...CONFIG, baseUrl },
    { repos, addressService, registrationLimiter: new RateLimiter(100, 60_000) } as never,
  ));
});

afterEach(async () => {
  await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  db.close();
});

describe("LUD-16 address lifecycle", () => {
  it("claims a username the owner can list back", async () => {
    const identity = newIdentity();
    const { token, username } = await onboard(identity, arkadeAddress(), "alice");

    const mine = await createLnurlClient({ baseUrl }).listAddresses(token);
    expect(mine.map((a) => a.username)).toEqual([username]);
  });

  it("stops resolving the address once it is revoked", async () => {
    const identity = newIdentity();
    const { token, username } = await onboard(identity, arkadeAddress(), "alice");
    expect((await payRequestFor(username)).tag).toBe("payRequest");

    await createLnurlClient({ baseUrl }).revokeAddress(token, username);

    expect((await payRequestFor(username)).status).toBe("ERROR");
  });

  it("refuses a second claim on a username already taken", async () => {
    await onboard(newIdentity(), arkadeAddress(), "alice");

    await expect(onboard(newIdentity(), arkadeAddress(), "alice")).rejects.toThrow();
  });

  it("rejects an arkade address that does not decode, before it reaches the wire", async () => {
    const identity = newIdentity();

    await expect(onboard(identity, "ark1qdefinitely-not-an-address", "alice"))
      .rejects.toThrow(/not a valid Arkade address/i);
  });
});

describe("restoring a wallet", () => {
  it("finds the username the token already owns, which re-registering cannot", async () => {
    const identity = newIdentity();
    const { token, username } = await onboard(identity, arkadeAddress(), "alice");

    // What a fresh browser has: the phrase, and nothing else.
    expect(await ownedUsername(token)).toBe(username);

    // And why it has to ask rather than re-claim -- the server refuses an
    // existing username without looking at who owns it.
    await expect(onboard(identity, arkadeAddress(), username)).rejects.toThrow();
  });

  it("reports nothing for a token that owns no address", async () => {
    expect(await ownedUsername(await tokenFor(newIdentity()))).toBeUndefined();
  });
});

describe("nameless onboarding", () => {
  const allowSession = () => {
    const domain = repos.domains.getByDomain(DOMAIN)!;
    repos.domains.update(domain.id, { allocationModes: ["self", "random", "session"] });
  };

  it("offers skipping a name only where the domain allows it", async () => {
    const rx = receiverAt(baseUrl, DOMAIN, { identity: newIdentity(), arkadeAddress: arkadeAddress() });
    expect((await rx.capabilities()).allocationModes).toEqual(["self", "random"]);

    allowSession();
    expect((await rx.capabilities()).allocationModes).toContain("session");
  });

  it("restores a nameless wallet as its LNURL, and names it without changing that LNURL", async () => {
    allowSession();
    const identity = newIdentity();
    const rx = receiverAt(baseUrl, DOMAIN, { identity, arkadeAddress: arkadeAddress() });
    const nameless = await rx.claim({ nameless: true });

    const restored = await receiverAt(baseUrl, DOMAIN, { identity, arkadeAddress: arkadeAddress() }).owned();
    expect(restored).toMatchObject({ handle: nameless.handle, lightningAddress: undefined, lnurl: nameless.lnurl });

    const named = await restored!.upgrade({ username: "carol" });
    expect(named).toMatchObject({ lightningAddress: `carol@${DOMAIN}`, lnurl: nameless.lnurl });
    expect((await rx.owned())?.handle).toBe("carol");
  });

  it("adopts the address a kept phrase already owns instead of claiming a second", async () => {
    allowSession();
    const identity = newIdentity();
    const { token } = await onboard(identity, arkadeAddress(), "dave");

    const rx = receiverAt(baseUrl, DOMAIN, { identity, arkadeAddress: arkadeAddress() });
    expect((await claimOrAdopt(rx, { nameless: true })).handle).toBe("dave");
    expect(await createLnurlClient({ baseUrl }).listAddresses(token)).toHaveLength(1);
  });
});

describe("LUD-06 payRequest", () => {
  it("advertises the amount envelope, metadata and comment allowance", async () => {
    const { username } = await onboard(newIdentity(), arkadeAddress(), "alice");

    const pr = await payRequestFor(username);
    expect(pr.tag).toBe("payRequest");
    expect(pr.minSendable).toBe(CONFIG.minSendable);
    expect(pr.maxSendable).toBe(CONFIG.maxSendable);
    expect(pr.metadata).toContain("text/identifier");
    expect(pr.metadata).toContain(`alice@${DOMAIN}`);
    expect(pr.callback).toContain(`/.well-known/lnurlp/${username}/callback`);
    expect(pr.commentAllowed).toBeGreaterThan(0);
  });

  it("accepts a comment within the advertised allowance", async () => {
    const { username } = await onboard(newIdentity(), arkadeAddress(), "alice");
    const pr = await payRequestFor(username);

    const res = await fetch(toTestUrl(`${pr.callback}?amount=50000&paymentOption=arkade&comment=thanks`));

    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).paymentOption).toBe("arkade");
  });
});

describe("payment activity", () => {
  it("serves an owner's activity as a resumable envelope", async () => {
    const { token, username } = await onboard(newIdentity(), arkadeAddress(), "alice");

    const rows = await payments(token, username);
    expect(rows).toEqual([]);

    // The envelope carries attribution and a cursor even when empty, which is
    // what makes it a sync source rather than a listing.
    const page = await createLnurlClient({ baseUrl }).listPayments(token, username);
    expect(page.source.lightningAddress).toBe(`alice@${DOMAIN}`);
    expect(page.nextSince).toBe(0);
  });

  it("refuses a token that does not own the address", async () => {
    const { username } = await onboard(newIdentity(), arkadeAddress(), "alice");
    const stranger = await tokenFor(newIdentity());

    // LnurlError, not LnurlTransportError: the distinction is the point, since a
    // bare toThrow() would also pass if the server were simply unreachable.
    await expect(payments(stranger, username)).rejects.toBeInstanceOf(LnurlError);
  });
});

describe("paymentOptions", () => {
  it("advertises both rails only once an Arkade identity is bound", async () => {
    const identity = newIdentity();
    const token = await tokenFor(identity);
    const client = createLnurlClient({ baseUrl });

    const reg = await client.registerAddress({ token, username: "alice" });
    expect((await payRequestFor(reg.username)).paymentOptions ?? []).toEqual([]);

    await onboard(identity, arkadeAddress(), "bob");
    expect((await payRequestFor("bob")).paymentOptions.map((o: any) => o.type)).toEqual(["lightning", "arkade"]);
  });

  it("answers the arkade option with a destination, not an invoice", async () => {
    const { username } = await onboard(newIdentity(), arkadeAddress(), "alice");
    const pr = await payRequestFor(username);

    const res = await fetch(toTestUrl(`${pr.callback}?amount=50000&paymentOption=arkade`));
    const body = await res.json() as Record<string, unknown>;

    expect(body.paymentOption).toBe("arkade");
    expect(body.paymentDestination).toBe(arkadeAddress());
    expect(body.pr).toBeUndefined();
  });
});

describe("routing through the rails", () => {
  // A LUD-16 address resolves as https on port 443 and the test server is http
  // on an ephemeral one, so only that hop is redirected. The resolve, the
  // callback, the rails and the server are all the real ones.
  const testFetch = ((input: unknown, init?: unknown) =>
    fetch(toTestUrl(String(input)), init as RequestInit)) as unknown as typeof fetch;

  const ctx = { wallet: {}, prefs: {} } as never;

  function rails() {
    const arkade = fakeRail("ark");
    const lightning = fakeRail("solver-lightning");
    const built = lnurlRails({ client: createLnurlClient({ fetchImpl: testFetch as never }), arkade, lightning });
    return { arkade, lightning, by: (id: string) => built.find((r) => r.id === id)! };
  }

  it("offers both rails for an address whose identity is bound", async () => {
    await onboard(newIdentity(), arkadeAddress(), "alice");
    const { by } = rails();
    const req = { raw: `alice@${DOMAIN}`, amount: 50 };

    expect(await by(LNURL_ARKADE_RAIL).available!(req, ctx)).toBe(true);
    expect(await by(LNURL_LIGHTNING_RAIL).available!(req, ctx)).toBe(true);
  });

  it("drops the arkade rail for an address with no bound identity", async () => {
    const token = await tokenFor(newIdentity());
    await createLnurlClient({ baseUrl }).registerAddress({ token, username: "bare" });
    const { by } = rails();
    const req = { raw: `bare@${DOMAIN}`, amount: 50 };

    expect(await by(LNURL_ARKADE_RAIL).available!(req, ctx)).toBe(false);
  });

  it("drops every rail for a username nobody registered", async () => {
    const { by } = rails();
    const req = { raw: `ghost@${DOMAIN}`, amount: 50 };

    expect(await by(LNURL_ARKADE_RAIL).available!(req, ctx)).toBe(false);
    expect(await by(LNURL_LIGHTNING_RAIL).available!(req, ctx)).toBe(false);
  });

  it("hands the callback's destination to the inner arkade rail", async () => {
    await onboard(newIdentity(), arkadeAddress(), "alice");
    const { by, arkade } = rails();

    const quote = await by(LNURL_ARKADE_RAIL).quote({ raw: `alice@${DOMAIN}`, amount: 50 }, ctx);

    expect(arkade.seen).toEqual([{ raw: arkadeAddress(), amount: 50 }]);
    expect(quote.railId).toBe(LNURL_ARKADE_RAIL);
  });

  it("gates on the server's amount envelope", async () => {
    await onboard(newIdentity(), arkadeAddress(), "alice");
    const { by } = rails();
    const raw = `alice@${DOMAIN}`;

    // minSendable is 1000 msat = 1 sat; maxSendable 100_000_000 msat = 100_000 sats.
    expect(await by(LNURL_ARKADE_RAIL).available!({ raw, amount: 200_000 }, ctx)).toBe(false);
    expect(await by(LNURL_ARKADE_RAIL).available!({ raw, amount: 50 }, ctx)).toBe(true);
  });
});
