import { defineConfig } from "vitest/config";

/**
 * The cross-language suite: the TypeScript enclave against the Go authority's
 * devserver. It builds that binary, so it needs a Go toolchain and `pnpm test` never
 * loads it; `pnpm test:authority` does.
 */
export default defineConfig({
  test: {
    pool: "forks",
    include: ["test/authority-interop/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    hookTimeout: 300_000,
    testTimeout: 30_000,
    execArgv: ["--experimental-sqlite"],
  },
});
