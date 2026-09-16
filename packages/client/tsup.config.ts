import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["packages/client/src/index.ts", "packages/client/src/arkade.ts"],
  outDir: "packages/client/dist",
  format: ["esm"],
  dts: true,
  clean: true,
  // Without this, tsup's dts pass picks the root tsconfig, whose rootDir "./src"
  // excludes this package and fails with TS6059.
  tsconfig: "packages/client/tsconfig.json",
  external: ["@scure/base", "@noble/hashes", "@arkade-os/sdk"],
});