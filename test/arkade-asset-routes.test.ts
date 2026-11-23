import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { ArkAddress } from "@arkade-os/sdk";
import { expect, it } from "vitest";
import { arkadeAssetOptions, createLnurlClient } from "../packages/client/src/index.js";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories } from "../src/db/repositories/index.js";
import { createServer } from "../src/http/server.js";
import { encodeLnurl } from "../src/lnurl.js";

it("serves exact asset instructions on the resolving origin without entering the Lightning callback", async () => {
  const db = openDb(":memory:");
  runMigrations(db);
  const repos = createRepositories(db);
  const domain = repos.domains.create({ domain: "127.0.0.1", allocationModes: ["self"] });
  const alias = repos.addresses.create({ domainId: domain.id, username: "alice", status: "active" });
  const signer = randomBytes(32);
  const destination = new ArkAddress(signer, randomBytes(32), "tark").encode();
  const assetId = "ab".repeat(34);
  repos.addresses.setOfflineReceive(alias.id, destination, "02" + "cd".repeat(32), {
    arkadeAssets: [assetId], methods: [{ type: "arkade-asset", destination: "custom-destination" }],
  });
  const app = createServer({ port: 0, baseUrl: "http://127.0.0.1", minSendable: 1000, maxSendable: 100_000 }, {
    repos, network: "regtest", arkadeSigner: signer.toString("hex"),
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    const client = createLnurlClient();
    const source = `http://127.0.0.1:${address.port}/.well-known/lnurlp/alice`;
    const payRequest = await client.resolve(encodeLnurl(source));
    const optionId = "registered:arkade-asset";
    expect(payRequest.paymentOptions).toContainEqual({ id: optionId, type: "arkade-asset", verifiable: false });
    const oldPayment = new URL(`${source}/callback`);
    oldPayment.search = new URLSearchParams({ amount: "1000", paymentOption: optionId }).toString();
    expect(await (await fetch(oldPayment)).json()).toMatchObject({ paymentOption: optionId, paymentDestination: "custom-destination" });
    const options = arkadeAssetOptions(payRequest);
    expect(options).toHaveLength(1);
    const [option] = options;
    expect(option).toMatchObject({ assetId, assetCallback: `${source}/callback/arkade-asset`, verifiable: false });
    const amount = "18446744073709551615";
    expect(await client.requestArkadeAssetPayment(payRequest, { assetId, amount })).toEqual({
      paymentOption: `arkade-asset:${assetId}`, paymentDestination: destination, assetId, assetAmount: amount, network: "regtest",
    });
    const post = async (body: object) => (await fetch(option!.assetCallback, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })).json();
    expect(await post({ assetId, amount: "18446744073709551616" })).toMatchObject({ status: "ERROR" });
    expect(await post({ assetId, amount, receipt: true })).toMatchObject({ status: "ERROR" });
    repos.addresses.setDisabledRails(alias.id, ["arkade-asset"]);
    expect(arkadeAssetOptions(await client.resolve(encodeLnurl(source)))).toEqual([]);
    expect(await post({ assetId, amount })).toMatchObject({ status: "ERROR" });
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((err) => err ? reject(err) : resolve()); });
    db.close();
  }
});
