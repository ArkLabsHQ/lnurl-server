import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const env = {
  NODE_ENV: "test", DB_PATH: "test.sqlite", ALLOW_INSECURE_TOKEN_STORAGE: "1",
  ARK_SERVER_URL: "http://localhost:7070", OFFLINE_EMULATOR_URL: "http://localhost:7073",
  OFFLINE_COVENANT_DESTINATIONS: "true",
};

describe("covenant renewal fee payer configuration", () => {
  it("passes an explicitly configured fee payer only when covenant destinations are enabled", () => {
    expect(loadConfig({ ...env, OFFLINE_COVENANT_RENEWAL_MNEMONIC: "operator fee payer" }).offlineReceive.covenantRenewalMnemonic).toBe("operator fee payer");
    expect(() => loadConfig({ ...env, OFFLINE_COVENANT_DESTINATIONS: "false", OFFLINE_COVENANT_RENEWAL_MNEMONIC: "operator fee payer" })).toThrow(/COVENANT_DESTINATIONS/);
  });
});
