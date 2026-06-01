import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // node:sqlite requires --experimental-sqlite on Node 22; pass it to worker processes.
    pool: "forks",
    forks: {
      execArgv: ["--experimental-sqlite"],
    },
  },
});
