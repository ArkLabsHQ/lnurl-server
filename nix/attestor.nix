{ buildGoModule }:
# Built as Enclave builds its runtime: CGO off, -trimpath, so the static binary is reproducible.
buildGoModule {
  pname = "lnurl-attest";
  version = "0.1.0";
  src = ../attestor;
  subPackages = [ "cmd/lnurl-attest" ];
  vendorHash = "sha256-ZhUqFMzspOpTlmJZ7Dsh1txr7dv4CHoijcSXicCf6ck=";
  env.CGO_ENABLED = "0";
  buildFlags = [ "-trimpath" ];
  meta.mainProgram = "lnurl-attest";
}
