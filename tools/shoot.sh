#!/bin/bash
# Renders the README screenshots in a throwaway headless GNOME Shell, with
# fake rbw / op binaries and a fake Clockify API (tools/fixtures), so no real
# vault or account is involved. Writes docs/*.png. Run via `make screenshots`.
set -u
UUID=quick-launcher@julian.falcondev.de
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
SANDBOX=${QL_SANDBOX:-/tmp/quick-launcher-shots}
OUT=${QL_OUT:-$ROOT/docs}
PORT=${QL_CLOCKIFY_PORT:-8765}

# A private bus, or the headless shell would lose org.gnome.Shell to the
# running session and every call below would drive the real desktop.
if [ -z "${QL_PRIVATE_BUS:-}" ]; then
  # The private bus daemon logs every service activation; keep that out of the way.
  QL_PRIVATE_BUS=1 exec dbus-run-session -- "$0" "$@" 2> >(grep -v '^dbus-daemon\[' >&2)
fi

[ -f "$ROOT/dist/metadata.json" ] || { echo "run 'make assets' first"; exit 1; }

rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"/{config,cache,state,fixture-state,data/gnome-shell/extensions}
cp -r "$ROOT/dist" "$SANDBOX/data/gnome-shell/extensions/$UUID"
cp -r "$HERE/driver" "$SANDBOX/data/gnome-shell/extensions/screenshot-driver@quick-launcher"

export XDG_CONFIG_HOME="$SANDBOX/config" XDG_DATA_HOME="$SANDBOX/data"
export XDG_CACHE_HOME="$SANDBOX/cache" XDG_STATE_HOME="$SANDBOX/state"
export QL_FIXTURE_STATE="$SANDBOX/fixture-state"
# Settings go to a throwaway keyfile, never the real dconf database.
export GSETTINGS_BACKEND=keyfile
unset WAYLAND_DISPLAY DISPLAY

gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$UUID', 'screenshot-driver@quick-launcher']"
gsettings set org.gnome.desktop.interface scaling-factor 2
gsettings set org.gnome.desktop.interface accent-color teal
set_ql() { gsettings --schemadir "$ROOT/dist/schemas" set org.gnome.shell.extensions.quick-launcher "$@"; }
set_ql rbw-path "$HERE/fixtures/rbw"
set_ql op-path "$HERE/fixtures/op"
set_ql onepassword-unlock password
set_ql clockify-api-key screenshot
set_ql clockify-api-url "http://127.0.0.1:$PORT/api/v1"

python3 -I "$HERE/fixtures/clockify.py" "$PORT" &
SERVER_PID=$!
gnome-shell --headless --wayland --no-x11 --virtual-monitor 2800x1800 >"$SANDBOX/shell.log" 2>&1 &
SHELL_PID=$!
trap 'kill $SHELL_PID $SERVER_PID 2>/dev/null; wait 2>/dev/null' EXIT

driver() { gdbus call --session --dest org.gnome.Shell --object-path /qltest --method "qltest.Driver.$1" "${@:2}" >/dev/null; }
keys() { local IFS=,; driver Keys "[$(printf "'%s'," "$@" | sed 's/,$//')]"; }
type_text() { driver Type "$1"; }
shot() {
  driver ShotLauncher "$OUT/$1.png" 48 &&
    magick "$OUT/$1.png" -strip -define png:compression-level=9 "$OUT/$1.png" &&
    echo "wrote docs/$1.png"
}

for _ in $(seq 60); do
  gdbus introspect --session --dest org.gnome.Shell --object-path /qltest 2>/dev/null | grep -q ShotLauncher && break
  sleep 0.5
done
driver HideOverview
sleep 2
mkdir -p "$OUT"

# Bitwarden starts unlocked, 1Password locked.
touch "$QL_FIXTURE_STATE/rbw-unlocked"

keys Control_L Shift_L Return
sleep 1.5
keys Return                      # "Unlock 1Password" is the first row
sleep 0.8
shot unlock
type_text hunter2
keys Return
sleep 1.5
type_text github
sleep 0.4
shot search
for _ in $(seq 6); do keys BackSpace; done
keys Down; keys Down; keys Down
sleep 0.4
shot passwords
keys Escape

keys Shift_L Alt_L Return
sleep 2
shot clockify
keys Escape

echo "--- shell log (extension-relevant lines) ---"
grep -iE "JS ERROR|St-WARNING|quick-launcher" "$SANDBOX/shell.log" | head -15
