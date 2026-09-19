import { defineConfig, devices } from "@playwright/test";
import { WALLET_PORT } from "./e2e-local/local-stack.js";

/**
 * The browser suite against a LOCAL stack. Run `pnpm test:browser:local` from
 * the repo root — the node flags that script sets are load-bearing. A second
 * config, not a project: a project cannot carry its own `webServer`, and the
 * mutinynet specs must not run here. The stack and the server are in
 * globalSetup because the runner starts every `webServer` BEFORE it.
 */
export default defineConfig({
  testDir: "./e2e-local",
  globalSetup: "./e2e-local/global-setup.ts",
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WALLET_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // `--host 127.0.0.1`: preview otherwise binds a name baseURL does not
    // resolve to. The bundle is the shipped one — the stored record aims it.
    command: `npx vite build && npx vite preview --port ${WALLET_PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${WALLET_PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
