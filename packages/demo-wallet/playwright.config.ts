import { defineConfig, devices } from "@playwright/test";

// Previewed from a production build rather than the dev server: what is deployed
// to Pages is the built bundle, and a dev-only difference is exactly the kind of
// thing this suite exists to catch.
const PORT = 4173;

// Point at a deployed site instead of a local preview:
//   E2E_BASE_URL=https://arklabshq.github.io/lnurl-server/ pnpm test:e2e
// Same suite, so "it works on my build" and "it works on Pages" are the same
// assertion rather than two different ones.
const deployed = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: deployed ?? `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(deployed
    ? {}
    : {
        webServer: {
          command: `pnpm -w run build:client && npx vite build && npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
          url: `http://127.0.0.1:${PORT}`,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
        },
      }),
});
