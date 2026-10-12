#!/usr/bin/env bash
# Builds an installable zip in build/ (gnome-extensions install --force <zip>).
set -euo pipefail
cd "$(dirname "$0")/.."

uuid="$(sed -n 's/.*"uuid": "\(.*\)".*/\1/p' src/metadata.json)"
scripts/build.sh
mkdir -p build
(cd dist && rm -f "../build/$uuid.zip" && zip -qr "../build/$uuid.zip" .)
ls build/*.zip
