import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { checkEmulatorPairing } from "../src/self-claim.js";

const EMULATOR_KEY = "02999413c46fa10ada5cbc4bcc79a1d09160c2ba3cfc812705d7a13e5e545fb2a9";
const OTHER_KEY = "03aa11787d87ee1d23ff47b61456d0159572abf1ae6f43ec816a9d605199b0b49";

const servers: http.Server[] = [];

async function serve(routes: Record<string, unknown>): Promise<string> {
  const server = http.createServer((req, res) => {
    const body = routes[req.url ?? ""];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const covclaimd = (emulatorPubKey: string) =>
  serve({ "/v1/preimage/covclaimd-pubkey": { covclaimd_pub_key: "02" + "11".repeat(32), emulator_pub_key: emulatorPubKey } });

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe("checkEmulatorPairing", () => {
  it("matches when the emulator signs with the key covclaimd's covenants name", async () => {
    const warnings: string[] = [];
    const result = await checkEmulatorPairing({
      covclaimdUrl: await covclaimd(EMULATOR_KEY),
      emulatorUrl: await serve({ "/v1/info": { version: "v0.0.6", signerPubkey: EMULATOR_KEY, deprecatedSignerPubkeys: [] } }),
      warn: (m) => warnings.push(m),
    });

    expect(result).toBe("matched");
    expect(warnings).toHaveLength(0);
  });

  it("warns, naming both keys, when the pair disagree", async () => {
    const warnings: string[] = [];
    const result = await checkEmulatorPairing({
      covclaimdUrl: await covclaimd(EMULATOR_KEY),
      emulatorUrl: await serve({ "/v1/info": { version: "v0.0.6", signerPubkey: OTHER_KEY, deprecatedSignerPubkeys: [] } }),
      warn: (m) => warnings.push(m),
    });

    expect(result).toBe("mismatched");
    expect(warnings[0]).toContain(OTHER_KEY);
    expect(warnings[0]).toContain(EMULATOR_KEY);
  });

  // A rotated emulator still satisfies covenants built under the key it retired.
  it("accepts a deprecated signer key rather than crying misconfiguration", async () => {
    const warnings: string[] = [];
    const result = await checkEmulatorPairing({
      covclaimdUrl: await covclaimd(EMULATOR_KEY),
      emulatorUrl: await serve({ "/v1/info": { version: "v0.0.7", signerPubkey: OTHER_KEY, deprecatedSignerPubkeys: [EMULATOR_KEY] } }),
      warn: (m) => warnings.push(m),
    });

    expect(result).toBe("matched");
    expect(warnings).toHaveLength(0);
  });

  it("stays quiet when a service is unreachable — a boot-time blip is not a misconfiguration", async () => {
    const warnings: string[] = [];
    const result = await checkEmulatorPairing({
      covclaimdUrl: await covclaimd(EMULATOR_KEY),
      emulatorUrl: "http://127.0.0.1:1",
      warn: (m) => warnings.push(m),
    });

    expect(result).toBe("unknown");
    expect(warnings).toHaveLength(0);
  });

  it("treats a non-200 as unknown, not as a mismatch", async () => {
    const warnings: string[] = [];
    const result = await checkEmulatorPairing({
      covclaimdUrl: await covclaimd(EMULATOR_KEY),
      emulatorUrl: await serve({}),
      warn: (m) => warnings.push(m),
    });

    expect(result).toBe("unknown");
    expect(warnings).toHaveLength(0);
  });
});
