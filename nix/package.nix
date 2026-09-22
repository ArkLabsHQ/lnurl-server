{ lib, pkgsStatic, writeText, nodejs_22, pnpm_10, fetchPnpmDeps, pnpmConfigHook, writableTmpDirAsHomeHook, profile }:
let
  node = nodejs_22;
  pnpm = pnpm_10.override {
    version = "10.25.0";
    hash = "sha256-DzcmZUsLXlLlgAkE3haK/Dxmfiq/hL2wbZrBOGEEvZA=";
    nodejs-slim = node;
  };
  source = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      (lib.fileset.fileFilter (file: lib.any file.hasExt [ "ts" "tsx" "css" "html" "json" ]) ../src)
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../tsconfig.json
      ../tsconfig.ui.json
      ../tsup.config.ts
      ../vite.config.ts
      ../scripts/smoke-dist.mjs
      ../packages/client/package.json
      ../packages/demo-wallet/package.json
    ];
  };
  environment = profile // { TZ = "UTC"; LANG = "C.UTF-8"; };
  header = writeText "lnurl-profile.h" ''
    #include <stddef.h>
    static char *app_env[] = {
      ${lib.concatStringsSep ",\n" (lib.mapAttrsToList (key: value: builtins.toJSON "${key}=${value}") environment)},
      NULL
    };
  '';
in
assert lib.versionAtLeast node.version "22.16.0" && lib.versionOlder node.version "23";
pkgsStatic.stdenv.mkDerivation (final: {
  pname = "lnurl-server";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  src = source;
  nativeBuildInputs = [ node pnpm pnpmConfigHook writableTmpDirAsHomeHook ];
  pnpmDeps = fetchPnpmDeps {
    inherit (final) pname src;
    inherit pnpm;
    fetcherVersion = 3;
    hash = "sha256-8WnAlbpFh0TgKsqecLT9bvp0QO9fdY14S4xH+KHV49w=";
  };
  env = { TZ = "UTC"; LANG = "C.UTF-8"; SOURCE_DATE_EPOCH = "1"; };
  buildPhase = ''
    runHook preBuild
    pnpm exec tsup
    pnpm exec vite build
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    rm -rf node_modules
    CI=true pnpm --filter @arkade-os/lnurl install --offline --frozen-lockfile --ignore-scripts --prod
    mkdir -p "$out/lib/lnurl"
    cp -r dist node_modules package.json "$out/lib/lnurl/"
    rm -f "$out/lib/lnurl/node_modules/.modules.yaml"
    rm -f "$out/lib/lnurl/node_modules/.pnpm-workspace-state-v1.json"
    mkdir -p "$out/bin"
    $CC -static -O2 -Wall -Wextra -Werror -include ${header} \
      -DNODE_BINARY='"${node}/bin/node"' -DAPP_ENTRY='"'"$out/lib/lnurl/dist/cli.js"'"' \
      -o "$out/bin/lnurl-enclave" ${./launcher.c}
    runHook postInstall
  '';
  passthru = { inherit pnpm source; };
  allowSubstitutes = false;
  preferLocalBuild = true;
  meta = { mainProgram = "lnurl-enclave"; platforms = [ "x86_64-linux" ]; };
})
