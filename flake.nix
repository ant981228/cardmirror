{
  description = "CardMirror — Electron desktop app for debate-card editing";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs, ... }:
    let
      inherit (nixpkgs) lib;
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];

      pkgsFor = system: import nixpkgs { inherit system; config.allowUnfree = true; };
      forAllSystems = f: lib.genAttrs systems (system: f system);

      # ── Build helpers (per-system) ───────────────────────────────

      mkApp = system:
        let
          pkgs = pkgsFor system;
          nodejs = pkgs.nodejs_22;
          electron = pkgs.electron;

          # Source filters
          rootSrc = ./.;

          desktopSrc = ./apps/desktop;

          # Renderer (Vite web app → extraResources/renderer)
          renderer = pkgs.buildNpmPackage {
            pname = "cardmirror-renderer";
            version = "0.1.0-beta.4";
            src = rootSrc;
            npmDepsHash = "sha256-/6FO0nJUpFd3Jg7P6qlFIcNCam1BTqUslWyANHr06to=";

            buildPhase = ''
              runHook preBuild
              npm run build -- --base=./
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p $out
              cp -r dist/* $out/
              runHook postInstall
            '';
          };

          # Desktop main process (TypeScript → JS)
          desktop = pkgs.buildNpmPackage {
            pname = "cardmirror-desktop";
            version = "0.1.0-beta.4";
            src = desktopSrc;
            npmDepsHash = "sha256-VvwUhETKT0HYggcS51xXLj28ZMds8njzudtD+OE4EZw=";

            nativeBuildInputs = with pkgs; [
              nodejs
              typescript  # needed for tsc (not in desktop's own deps)
              python3
              pkg-config
            ];

            buildInputs = with pkgs; [
              libffi
              stdenv.cc.cc.lib
            ];

            buildPhase = ''
              runHook preBuild
              npm run build:main
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p $out/{dist,node_modules}
              cp -r dist/* $out/dist/
              cp -r node_modules $out/
              cp package.json $out/
              runHook postInstall
            '';
          };

        # Combined Electron app
        in pkgs.stdenv.mkDerivation {
          pname = "cardmirror";
          version = "0.1.0-beta.4";
          src = ./.;

          nativeBuildInputs = with pkgs; [ makeWrapper python3 ];
          buildInputs = [ electron ];
          dontBuild = true;
          dontConfigure = true;

          installPhase = ''
            runHook preInstall

            mkdir -p $out/{bin,lib/cardmirror,share/applications,share/icons/hicolor/256x256/apps}

            # Copy desktop main process dist
            mkdir -p $out/lib/cardmirror/dist
            cp -r ${desktop}/dist/* $out/lib/cardmirror/dist/
            chmod +w $out/lib/cardmirror/dist/main.js

            # Patch main.js: force packaged mode, fix renderer path
            python3 << 'EOF'
import os, re
path = os.environ['out'] + '/lib/cardmirror/dist/main.js'
with open(path) as f:
    c = f.read()
# TypeScript compiles `import { app }` to `const electron_1 = require("electron")`
# so `!app.isPackaged` becomes `!electron_1.app.isPackaged`
c = re.sub(r'!([\w.]+\.)?app\.isPackaged', 'false', c)
# Fix renderer path: process.resourcesPath → __dirname/..
c = c.replace(
    "process.resourcesPath, 'renderer', 'index.html'",
    "__dirname, '..', 'renderer', 'index.html'",
)
with open(path, 'w') as f:
    f.write(c)
EOF

            # node_modules (native addons)
            cp -r ${desktop}/node_modules $out/lib/cardmirror/

            # Renderer (extraResources)
            cp -r ${renderer} $out/lib/cardmirror/renderer

            # Extra resources (template, flow scripts)
            cp -r $src/apps/desktop/resources $out/lib/cardmirror/

            # Desktop package.json (needed by electron-updater)
            cp ${desktop}/package.json $out/lib/cardmirror/

            cp $src/apps/desktop/build/icons/256x256.png \
               $out/share/icons/hicolor/256x256/apps/cardmirror.png

            printf '%s\n' \
              '[Desktop Entry]' \
              'Name=CardMirror' \
              "Exec=$out/bin/cardmirror" \
              'Type=Application' \
              'Categories=Office;' \
              'Icon=cardmirror' \
              'Terminal=false' \
              > $out/share/applications/cardmirror.desktop

            makeWrapper ${electron}/bin/electron $out/bin/cardmirror \
              --add-flags "$out/lib/cardmirror/dist/main.js" \
              --set ELECTRON_IS_DEV 0 \
              --set NODE_ENV production \
              --chdir "$out/lib/cardmirror"

            runHook postInstall
          '';

          meta = with lib; {
            description = "ProseMirror editor for debate cards that interoperates with Advanced Verbatim";
            homepage = "https://github.com/ant981228/cardmirror";
            license = licenses.unfree;
            platforms = platforms.linux;
            mainProgram = "cardmirror";
          };
        };

      # ── Dev shell (per-system) ──────────────────────────────────

      mkDevShell = system:
        let pkgs = pkgsFor system;
        in pkgs.mkShell {
          packages = with pkgs; [
            pkgs.nodejs_22
            pkgs.typescript
            pkgs.electron
          ];
        };
    in
    {
      packages = forAllSystems (system: {
        default = mkApp system;
      });

      devShells = forAllSystems (system: {
        default = mkDevShell system;
      });
    };
}
