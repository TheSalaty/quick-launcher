# Development

```sh
pnpm install
make check             # typecheck, lint, unit tests (node --test runs the .ts files directly, Node 24)
make install           # build into dist/ and copy to ~/.local/share/gnome-shell/extensions
make logs              # follow gnome-shell's journal
make screenshots       # re-render docs/*.png in a headless shell
make pack              # installable zip
```

On Wayland the shell cannot reload an extension in place, so log out and back in after
`make install`.

```
src/extension.ts        enable/disable, keybindings
src/prefs.ts            Adwaita preferences, shortcut recorder, pinentry bridge installer
src/lib/launcher.ts     the popup: search field, pooled rows, password prompt mode
src/lib/search.ts       Bitwarden-style token search (no GI imports, unit tested)
src/lib/output.ts       secret clipboard, virtual keyboard, timers
src/lib/subprocess.ts   Gio.Subprocess wrapper; secrets go over stdin, never argv
src/passwords/          Vault interface, rbw and 1Password vaults, the D-Bus pinentry service
src/clockify/           API client, the launcher, task grouping and @project/#tag parsing
src/bin/pinentry.ts     the pinentry program rbw runs when the bridge is on
tools/                  headless screenshot harness with fake rbw, op and Clockify
test/                   unit tests
```

TypeScript is compiled file by file with `tsc` (no bundler), so `dist/` mirrors `src/`. Types
come from [`@girs`](https://github.com/gjsify/ts-for-gir). Sources import each other with `.ts`
extensions; `rewriteRelativeImportExtensions` turns them into `.js` for GJS, and Node runs the
unit tests from the sources directly.

## Vaults

Both password managers implement `Vault` in `src/passwords/vault.ts`: `isUnlocked`, `unlock`,
`list`, `secret`, `sync` and `lock`. `list` returns metadata only. The launcher keeps it in
memory and searches it, and asks the vault for a password or TOTP code only when one is used.

`Passwords` (`src/passwords/passwords.ts`) opens the popup immediately with the items it already
has, then checks every enabled vault in parallel. Each vault reload carries a generation number,
so a slow answer that was overtaken by a newer one is dropped. A vault that is locked or failing
becomes a row of its own. Enter on that row calls `unlock` with a `Prompter`, which can either
turn the search field into a password field (`askSecret`) or hide the popup while another
program's prompt needs the keyboard (`stepAside`).

### 1Password

`op` runs as a subprocess for every call (`whoami`, `item list --format json`,
`item get --format json --reveal`, `item get --otp`). With desktop app integration, the app
manages the session and `op signin` shows its prompt. Otherwise the typed master password goes
to `op signin --raw` on stdin and the token it prints is passed back with `--session`. It lives
only in the extension's memory. An `op` error that means "signed out" turns the vault back into
an unlock row.

### Bitwarden and the pinentry bridge

rbw has no way to take the master password other than running a pinentry program, configured
with `rbw config set pinentry`. The bridge, installed by the preferences into
`~/.local/share/quick-launcher/`, is:

- `pinentry`: a shell wrapper. If the extension answers `Ping` on
  `/de/falcondev/QuickLauncher/Pinentry` (on the shell's session bus name `org.gnome.Shell`), it
  runs `pinentry.js`, otherwise it `exec`s the previous pinentry.
- `pinentry.js` (from `src/bin/pinentry.ts`): speaks the Assuan protocol on stdin/stdout and
  forwards `GETPIN` to the extension's `GetPin` D-Bus method, which shows the password prompt in
  the launcher.

The D-Bus object is only exported while the setting is on. rbw reads its config on every
prompt, so switching takes effect without restarting the agent.

## Launcher

Rows are created on first use and then reused: typing changes their labels instead of
destroying and rebuilding actors. At most 50 rows are shown. Selection follows the item id
across refreshes, so background reloads don't make it jump.

## Screenshots

`tools/shoot.sh` re-runs itself on a private D-Bus session and starts a headless GNOME Shell on a
2800×1800 virtual monitor at scale 2, with a throwaway XDG home and the keyfile GSettings
backend, so the real desktop's dconf and session bus are untouched. It loads `dist/` and
`tools/driver`, a small helper extension that exposes a virtual keyboard and
`Shell.Screenshot.screenshot_area` over D-Bus. The script then drives the launcher like a user
and crops each shot to the popup plus a margin.

`rbw` and `op` are replaced by the scripts in `tools/fixtures`, which serve the JSON next to
them (the 1Password master password is `hunter2`). `tools/fixtures/clockify.py` is a fake
Clockify API on `127.0.0.1:8765`.

```sh
make screenshots       # writes docs/passwords.png, search.png, unlock.png, clockify.png
```

## Releasing

1. Bump `version` in `package.json` and `version-name` in `src/metadata.json`, and increment
   `version` there.
2. Tag `vX.Y.Z` and attach `make pack`'s zip to a GitHub release.
3. In `packaging/`, set `pkgver` and run `updpkgsums`.
