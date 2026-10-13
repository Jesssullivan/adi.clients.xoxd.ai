{
  description = "adi overlay: one image with the pinned adi-sms runtime, valkey, the deck and its server";

  # The pinned core: the overlay recipes add the gh token to NIX_CONFIG when there is one; CI fetches it over SSH.
  inputs.adi-sms.url = "github:Jesssullivan/adi-sms/1b82a33380b486bc8662c8191846b70e21ced22d";

  outputs =
    { adi-sms, ... }:
    let
      system = "x86_64-linux";
      pkgs = adi-sms.inputs.nixpkgs.legacyPackages.${system};
      # The core's runtime: CPython 3.15.0 with adi-sms and redis-py (bin/python, bin/sms).
      venv = adi-sms.packages.${system}.default;
      # What ./pyproject.toml adds (uv.lock: PyJWT and cryptography; pyyaml for the tests), as a site-packages path for
      # PYTHONPATH, built on the core's interpreter:
      # its flake.nix overrides the pinned set's python315 (3.15.0rc2) to 3.15.0 the same way.
      py = pkgs.extend (_: prev: {
        python315 = prev.python315.override {
          sourceVersion = { major = "3"; minor = "15"; patch = "0"; suffix = ""; };
          hash = "sha256-ukvtG6NGuRaJC3bZ4yBFFCCqafZAiZfTPGZILurj1XU=";
        };
      });
      extra =
        groups:
        let
          inherit (adi-sms.inputs) uv2nix pyproject-nix pyproject-build-systems;
          set = (py.callPackage pyproject-nix.build.packages { python = py.python315; }).overrideScope (
            pkgs.lib.composeManyExtensions [
              pyproject-build-systems.overlays.wheel
              ((uv2nix.lib.workspace.loadWorkspace { workspaceRoot = ./.; }).mkPyprojectOverlay { sourcePreference = "wheel"; })
              (final: prev: { # pyyaml has no 3.15 wheel yet; its sdist names its build system, which uv.lock does not carry
                pyyaml = prev.pyyaml.overrideAttrs (o: {
                  nativeBuildInputs = o.nativeBuildInputs ++ final.resolveBuildSystem { setuptools = [ ]; cython = [ ]; };
                });
              })
            ]
          );
        in
        "${set.mkVirtualEnv "adi-overlay-env" { adi-overlay = groups; }}/lib/python3.15/site-packages";
      # The core's three Job templates (queue, producer, senders), which the server fills for every run.
      deploy = pkgs.runCommand "adi-sms-deploy" { } "mkdir -p $out/deploy && cp ${adi-sms}/deploy/*.yaml $out/deploy/";
      # sms and python from the runtime, valkey-server for the queue pod
      bin = pkgs.symlinkJoin { name = "adi-sms-bin"; paths = [ venv pkgs.valkey ]; };
    in
    {
      packages.${system}.env = bin;

      # `just overlay-image` builds this with --impure and ADI_SITE, the deck build it staged. The speaker notes are
      # not in the image: the Deployment mounts them from the notes Secret.
      legacyPackages.${system}.image =
        let
          site = builtins.getEnv "ADI_SITE";
        in
        assert site != "";
        pkgs.dockerTools.buildLayeredImage {
          name = "ghcr.io/jesssullivan/adi-sms";
          tag = "site";
          contents = [ venv pkgs.valkey pkgs.cacert deploy ]; # cacert: the server verifies the Access signing keys' TLS
          extraCommands = ''
            mkdir -p app srv
            cp ${./server.py} app/server.py
            cp -r ${builtins.path { path = /. + site; name = "deck"; }} srv/deck
          '';
          config = {
            Cmd = [ "${venv}/bin/python" "/app/server.py" ];
            User = "65532:65532";
            WorkingDir = "/app";
            ExposedPorts."8080/tcp" = { };
            Env = [ "PATH=/bin" "PYTHONUNBUFFERED=1" "PYTHONDONTWRITEBYTECODE=1"
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" "PYTHONPATH=${extra [ ]}" ];
          };
        };

      # the pinned package answers the pinned fold for the defaults
      checks.${system}.fold = pkgs.runCommand "adi-overlay-fold" { } ''
        [ "$(${venv}/bin/sms fold)" = '{"sent":893,"failed":107,"attempts":1000,"time_us":99301920}' ] && touch $out
      '';

      devShells.${system}.default = pkgs.mkShell {
        packages = [ bin pkgs.kubectl pkgs.kustomize pkgs.kubeconform pkgs.kind pkgs.skopeo pkgs.tailscale ]; # tailscale: CI's deploy
        ADI_DEPLOY = "${deploy}/deploy";
        PYTHONPATH = extra [ "dev" ]; # with pyyaml, for test_server.py
      };
    };
}
