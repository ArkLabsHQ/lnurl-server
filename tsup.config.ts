import { defineConfig } from "tsup";

export default defineConfig({
  // Named so admin-server lands at dist/admin-server.js: it serves the UI from its own directory (dist/admin-ui).
  entry: { index: "src/index.ts", cli: "src/cli.ts", "admin-server": "src/http/admin-server.ts" },
  format: ["esm"],
  dts: true,
  // tsup strips the `node:` protocol prefix by default (removeNodeProtocol: true),
  // rewriting e.g. `node:sqlite` → `sqlite`. That is fatal for prefix-only builtins
  // like node:sqlite (there is no bare `sqlite` builtin), so disable it.
  removeNodeProtocol: false,
});
