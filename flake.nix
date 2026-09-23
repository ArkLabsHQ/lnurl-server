{
  description = "Reproducible LNURL research workload for AWS Nitro Enclaves";

  inputs.enclave.url = "github:ArkLabsHQ/enclave/3c33a40ef4a2a49297ab5df5163945fa9e50e544";
  inputs.nixpkgs.follows = "enclave/nixpkgs";

  outputs = { self, nixpkgs, enclave }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      profile = builtins.fromJSON (builtins.readFile ./nix/profile.json);
      attestor = pkgs.callPackage ./nix/attestor.nix { };
      app = pkgs.callPackage ./nix/package.nix { inherit profile; attestor = null; };
      appAttest = pkgs.callPackage ./nix/package.nix { inherit profile attestor; };
      eifOf = app: (enclave.lib.buildEif {
        inherit pkgs app;
        env = profile;
      }).overrideAttrs (_: { allowSubstitutes = false; preferLocalBuild = true; });
    in {
      packages.${system} = {
        default = app;
        inherit app attestor;
        eif = eifOf app;
        # Opt-in until the helper has quoted on real Nitro: the default image stays as it was.
        app-attest = appAttest;
        eif-attest = eifOf appAttest;
      };
      devShells.${system}.default = pkgs.mkShell {
        packages = [ pkgs.nodejs_22 app.pnpm pkgs.jq ];
      };
    };
}
