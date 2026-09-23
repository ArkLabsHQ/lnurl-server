import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  // The client's package entry points at dist/, which CI builds only after the
  // tests run, so consumers under packages/ resolve to its source instead --
  // the same thing test/client-contract.test.ts does by importing the path
  // directly. Longest specifier first; a prefix match would swallow /arkade.
  resolve: {
    alias: [
      { find: "@arkade-os/lnurl-client/arkade", replacement: resolve(__dirname, "packages/client/src/arkade.ts") },
      { find: "@arkade-os/lnurl-client", replacement: resolve(__dirname, "packages/client/src/index.ts") },
    ],
  },
  test: {
    // node:sqlite requires --experimental-sqlite on Node 22; pass it to worker processes.
    // Vitest 4: execArgv is a top-level option (poolOptions was removed).
    pool: "forks",
    execArgv: ["--experimental-sqlite"],
    include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // The e2e suite (vitest.e2e.config.ts, `pnpm test:e2e`) needs the docker regtest
    // stack, and the authority suite (`pnpm test:authority`) a Go toolchain: never
    // load either from the unit run.
    exclude: ["test/e2e/**", "test/authority-interop/**", "**/node_modules/**"],
  },
});
