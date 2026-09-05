import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

/**
 * E2E-only config — never loaded by `pnpm test` (the base config excludes test/e2e
 * from its include set, and this file exists only when explicitly named).
 *
 * Adds `--experimental-eventsource` to the test fork: the Arkade SDK's background
 * machinery opens an EventSource, and vitest forks do not inherit NODE_OPTIONS.
 * Sequential forks: the suite shares one regtest stack (and one solver float).
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      dir: "test/e2e",
      fileParallelism: false,
      // Hooks do stack bring-up / funding; the default 10s hook timeout is far too tight.
      hookTimeout: 30 * 60_000,
      // Vitest 4 removed poolOptions: execArgv is top-level now (forks don't inherit
      // NODE_OPTIONS, and the SDK needs EventSource in the fork).
      execArgv: ["--experimental-sqlite", "--experimental-eventsource"],
    },
  }),
);
