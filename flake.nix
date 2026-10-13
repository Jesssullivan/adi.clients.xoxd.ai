{
  description = "adi.clients.xoxd.ai development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        # What the Justfile calls: node and pnpm (pnpm switches to the packageManager pin), gh for the docs
        # copy and the overlay recipes' token, gitleaks for secrets-scan-dir, python3 for repin, kubectl for `just notes`, jq for CI.
        # On Linux, Playwright uses the Nix Chromium with a fonts.conf, or a bare CI cell renders no glyphs.
        default = pkgs.mkShell {
          packages =
            with pkgs;
            [ nodejs_22 pnpm just git gh gitleaks python3 kubectl jq ]
            ++ lib.optionals stdenv.isLinux [ chromium ];
          shellHook = pkgs.lib.optionalString pkgs.stdenv.isLinux ''
            export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
            export FONTCONFIG_FILE="${
              pkgs.makeFontsConf {
                fontDirectories = [ pkgs.dejavu_fonts pkgs.liberation_ttf ];
              }
            }"
          '';
        };
      });
    };
}
