import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeBootEndpoint } from "../src/boot-probe.js";
import { UpstreamError } from "../src/errors.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("probeBootEndpoint", () => {
  it("returns a healthy response", async () => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"signerPubkey":"02ff"}');
    }).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");

    const response = await probeBootEndpoint(`http://127.0.0.1:${address.port}/v1/info`, "emulator info endpoint");

    expect(response.ok).toBe(true);
    await response.body?.cancel();
  });

  it("names the service and status when boot would fail", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 503;
      res.end();
    }).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");

    const probe = probeBootEndpoint(`http://127.0.0.1:${address.port}/v1/info`, "emulator info endpoint");

    await expect(probe).rejects.toEqual(new UpstreamError("emulator info endpoint", 503));
  });
});
