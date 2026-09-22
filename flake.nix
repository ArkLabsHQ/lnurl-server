{
  description = "Reproducible LNURL research workload for AWS Nitro Enclaves";

  inputs.enclave.url = "github:ArkLabsHQ/enclave/3c33a40ef4a2a49297ab5df5163945fa9e50e544";
  inputs.nixpkgs.follows = "enclave/nixpkgs";

  outputs = { self, nixpkgs, enclave }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      profile = builtins.fromJSON (builtins.readFile ./nix/profile.json);
      app = pkgs.callPackage ./nix/package.nix { inherit profile; };
    in {
      packages.${system} = {
        default = app;
        inherit app;
        eif = (enclave.lib.buildEif {
          inherit pkgs app;
          env = profile;
        }).overrideAttrs (_: { allowSubstitutes = false; preferLocalBuild = true; });
      };
      devShells.${system}.default = pkgs.mkShell {
        packages = [ pkgs.nodejs_22 app.pnpm pkgs.jq ];
      };
    };
}
