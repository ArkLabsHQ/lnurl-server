import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/admin-server.ts"],
  format: ["esm"],
  dts: true,
  // tsup strips the `node:` protocol prefix by default (removeNodeProtocol: true),
  // rewriting e.g. `node:sqlite` → `sqlite`. That is fatal for prefix-only builtins
  // like node:sqlite (there is no bare `sqlite` builtin), so disable it.
  removeNodeProtocol: false,
});
