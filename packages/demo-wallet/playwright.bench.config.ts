import { defineConfig, devices } from "@playwright/test";

/**
 * Rail latency against the local stack. A third config rather than a project in
 * the local one: folding these into the correctness suite would make every run
 * pay for them, and filtering them back out is how a suite quietly stops running
 * things. No `webServer` — nothing here drives a browser.
 */
export default defineConfig({
  testDir: "./e2e-bench",
  // Not the default *.spec.ts: the name is what keeps these out of a suite that
  // only ever meant to run correctness tests.
  testMatch: "**/*.bench.ts",
  globalSetup: "./e2e-local/global-setup.ts",
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Serial on purpose: concurrent payments would queue behind each other in arkd
  // and the number reported would be contention, not latency.
  workers: 1,
  reporter: [["list"]],
  projects: [{ name: "bench", use: { ...devices["Desktop Chrome"] } }],
});
