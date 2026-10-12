#!/usr/bin/env bash
# Builds the extension and links dist/ into the user's extension directory,
# so later `pnpm build` runs are picked up after a re-login.
set -euo pipefail
cd "$(dirname "$0")/.."

uuid="$(sed -n 's/.*"uuid": "\(.*\)".*/\1/p' src/metadata.json)"
extensions="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"

scripts/build.sh
mkdir -p "$extensions"
ln -sfn "$PWD/dist" "$extensions/$uuid"
echo "Installed to $extensions/$uuid"
echo "Enable with: gnome-extensions enable $uuid (on Wayland, log out and back in first)"
