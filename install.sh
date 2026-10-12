#!/usr/bin/env bash
# Symlinks the extension into the user's extension directory and compiles
# its settings schema. On Wayland, log out and back in afterwards once.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
uuid="quick-launcher@julian.falcondev.de"
extensions="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
target="$extensions/$uuid"

# Migrate from the old bitwarden-launcher extension.
old_uuid="bitwarden-launcher@julian.falcondev.de"
if [[ -L "$extensions/$old_uuid" ]]; then
  gnome-extensions disable "$old_uuid" 2>/dev/null || true
  rm "$extensions/$old_uuid"
  if [[ -z "$(dconf dump /org/gnome/shell/extensions/quick-launcher/)" ]]; then
    dconf dump /org/gnome/shell/extensions/bitwarden-launcher/ |
      dconf load /org/gnome/shell/extensions/quick-launcher/
  fi
  echo "Removed old $old_uuid (settings migrated)"
fi

glib-compile-schemas --strict "$here/src/schemas"
mkdir -p "$extensions"
ln -sfn "$here/src" "$target"
echo "Installed to $target"
echo "Enable with: gnome-extensions enable $uuid"
