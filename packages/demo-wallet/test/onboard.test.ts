import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { ArkAddress, MnemonicIdentity } from "@arkade-os/sdk";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { createServer } from "../../../src/server.js";
import { openDb, type Db } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { createRepositories, type Repositories } from "../../../src/db/repositories/index.js";
import { AddressService } from "../../../src/services/addresses.js";
import { createLnurlClient } from "@arkade-os/lnurl-client";
import type { ArkadeSigner } from "@arkade-os/lnurl-client/arkade";
import { bootState, receiverAt } from "../src/lnurl.js";

// The host the client will send, since it connects by IP: the server resolves
// the domain from the Host header when the body names none.
const DOMAIN = "127.0.0.1";

function arkadeAddress(): string {
  return new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), "tark").encode();
}

/** Fetched directly rather than through `resolve`, which builds an https LUD-16
 *  URL and so cannot reach an ephemeral http test port. */
async function payRequestFor(username: string): Promise<{ paymentOptions?: { id: string; type: string }[] }> {
  const res = await fetch(`${baseUrl}/.well-known/lnurlp/${username}`);
  return res.json() as Promise<{ paymentOptions?: { id: string; type: string }[] }>;
}

/** The old `api.onboard` shape over the facade, plus the token tests need. */
const onboard = async (identity: ArkadeSigner, arkadeAddress: string, username: string) => {
  const rx = receiverAt(baseUrl, DOMAIN, { identity, arkadeAddress });
  const claimed = await rx.claim({ username });
  return { username: claimed.handle, lightningAddress: claimed.lightningAddress, token: await rx.token() };
};

let db: Db;
let repos: Repositories;
let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  db = openDb(":memory:");
  runMigrations(db);
  repos = createRepositories(db);
  repos.domains.create({ domain: DOMAIN, allocationModes: ["self", "random", "session"] });
  const addressService = new AddressService(repos, randomBytes(32));
  server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, DOMAIN, () => resolve()));
  const { port } = server.address() as { port: number };
  baseUrl = `http://${DOMAIN}:${port}`;
  server.on("request", createServer(
    { port: 0, baseUrl, minSendable: 1_000, maxSendable: 100_000_000 },
    { repos, addressService } as never,
  ));
});

afterEach(async () => {
  await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  db.close();
});

describe("onboarding", () => {
  it("binds the identity so the payRequest advertises the arkade rail", async () => {
    const identity = MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist));

    const result = await onboard(identity, arkadeAddress(), "alice");
    expect(result.lightningAddress).toBe(`alice@${DOMAIN}`);

    const payRequest = await payRequestFor(result.username);
    expect(payRequest.paymentOptions?.map((o) => o.type)).toContain("arkade");
  });

  it("derives the same token every call, so the address is not orphaned", async () => {
    const identity = MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist));

    expect(await receiverAt(baseUrl, DOMAIN, { identity, arkadeAddress: arkadeAddress() }).token()).toBe(await receiverAt(baseUrl, DOMAIN, { identity, arkadeAddress: arkadeAddress() }).token());
  });

  it("leaves a username with no bound identity off the arkade rail", async () => {
    const client = createLnurlClient({ baseUrl });
    const identity = MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist));

    // Register only — the half of onboard() that claims the name.
    const registered = await client.registerAddress({ token: await receiverAt(baseUrl, DOMAIN, { identity, arkadeAddress: arkadeAddress() }).token(), username: "bob" });

    const payRequest = await payRequestFor(registered.handle);
    expect(payRequest.paymentOptions ?? []).toEqual([]);
  });

  it("advertises paymentOptions for a nameless receiver with the page closed", async () => {
    const identity = MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist));
    const rx = receiverAt(baseUrl, DOMAIN, { identity, arkadeAddress: arkadeAddress() });

    const claimed = await rx.claim({ nameless: true });
    expect(claimed.lightningAddress).toBeUndefined();

    // No openSession call anywhere in this test: the identity bind alone is
    // enough for /lnurl/<sid> to advertise the arkade rail.
    const payRequest = await claimed.payRequest();
    expect(payRequest.paymentOptions?.map((o) => o.type)).toContain("arkade");
  });
});

describe("boot", () => {
  it("sends a wallet with no address to onboarding, and one with an address to it", async () => {
    const identity = MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist));
    const rx = receiverAt(baseUrl, DOMAIN, { identity, arkadeAddress: arkadeAddress() });
    expect(await bootState(rx)).toEqual({ kind: "onboard" });

    await rx.claim({ username: "carol" });
    const booted = await bootState(rx);
    expect(booted.kind === "ready" && booted.receiver.handle).toBe("carol");
  });

  it("keeps a wallet out of onboarding when lnurl-server cannot answer", async () => {
    const down = http.createServer((_req, res) => { res.writeHead(502); res.end("bad gateway"); });
    await new Promise<void>((resolve) => down.listen(0, DOMAIN, () => resolve()));
    const { port } = down.address() as { port: number };
    try {
      const identity = MnemonicIdentity.fromMnemonic(generateMnemonic(wordlist));
      const booted = await bootState(receiverAt(`http://${DOMAIN}:${port}`, DOMAIN, { identity, arkadeAddress: arkadeAddress() }));
      expect(booted.kind).toBe("unreachable");
    } finally {
      await new Promise<void>((resolve) => { down.closeAllConnections(); down.close(() => resolve()); });
    }
  });
});
