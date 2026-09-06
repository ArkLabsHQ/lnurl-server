import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // node:sqlite requires --experimental-sqlite on Node 22; pass it to worker processes.
    // Vitest 4: execArgv is a top-level option (poolOptions was removed).
    pool: "forks",
    execArgv: ["--experimental-sqlite"],
    // The e2e suite (vitest.e2e.config.ts, `pnpm test:e2e`) needs the docker regtest
    // stack — never load it from the unit run.
    exclude: ["test/e2e/**", "**/node_modules/**"],
  },
});
