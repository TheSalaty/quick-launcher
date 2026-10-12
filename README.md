# Quick Launcher

A GNOME Shell extension (GNOME 48–50, Wayland) with two Spotlight-style popups:

- **Passwords**: one search over **Bitwarden** (via [rbw](https://github.com/doy/rbw))
  and **1Password** (via the [`op` CLI](https://developer.1password.com/docs/cli/)).
  Every row shows which vault it comes from. Locked vaults show up as a row
  you can unlock right there, with the master password typed into the
  launcher.
- **Clockify**: searches your recent time entries and starts a new timer
  with the same description, project, task and tags, or a new one.

Typing uses a Clutter virtual keyboard inside the shell, so no ydotool /
wtype / uinput daemon is needed. Copied secrets are cleared after 30 s
(only if the clipboard still holds them) and removed from Clipboard
Indicator's history.

## Install

Needs Node.js and pnpm to build.

```sh
pnpm install
pnpm install-local            # builds into dist/ and links it into ~/.local/share/gnome-shell/extensions
gnome-extensions enable quick-launcher@julian.falcondev.de
```

On Wayland, log out and back in once so the shell picks up the extension.
After that, `pnpm build` and a re-login are enough to update.
`pnpm zip` builds `build/quick-launcher@julian.falcondev.de.zip` for
`gnome-extensions install --force`.

Upgrading from the JavaScript version: run `pnpm install-local` once, it
replaces the old link to `src/`. Settings are kept.

## Passwords

| Key                   | Action                                       |
| --------------------- | -------------------------------------------- |
| Ctrl+Shift+Enter      | open / close the launcher                    |
| Enter                 | copy password (on a locked vault: unlock it) |
| Shift+Enter           | type password, Enter                         |
| Ctrl+Enter            | type username, Tab, password, Enter          |
| Alt+P / Alt+U / Alt+T | copy password / username / TOTP (add Shift to type) |
| Up/Down, Tab, Ctrl+N/P | move selection                              |
| Ctrl+R                | sync and reload                              |
| Ctrl+L                | lock all vaults                              |
| Esc                   | close (or cancel a password prompt)          |

The launcher opens instantly with what it already knows and checks the
vaults in the background. The last query and the last-used item are
restored on open, with the query pre-selected so you can just press Enter
or start typing.

Search works like the Bitwarden clients: every word is matched as a
substring against name (weighted most), username, URLs and folder / vault,
so items matching more words rank first.

Only item metadata (name, username, folder, URLs) is kept in memory;
passwords and TOTP codes are fetched when you use them.

### Bitwarden (rbw)

Set up rbw first (`rbw config set email …`, `rbw register`, `rbw login`).
rbw always asks for the master password through a pinentry program. To get
that prompt in the launcher instead, turn on **Enter master password in the
launcher** in the preferences. This installs a small bridge
(`~/.local/share/quick-launcher/pinentry`) and points rbw's `pinentry` at
it; turning it off restores the previous pinentry. The bridge falls back to
that pinentry whenever the extension isn't running, and also answers
prompts from rbw on the command line (the launcher pops up).

Without the bridge, unlocking hides the launcher while your pinentry asks,
then brings it back.

### 1Password (op)

Two ways to unlock, picked automatically (or set in the preferences):

- **Desktop app**: with *Settings → Developer → Integrate with 1Password
  CLI* turned on, unlocking hands over to the app's prompt (system
  authentication / fingerprint).
- **Master password**: for accounts added with `op account add`. You type the
  password into the launcher; it goes to `op signin --raw` on stdin and the
  session token stays in memory only (it expires after 30 min idle, then the
  vault shows up as locked again).

Set *Account* if you have more than one.

## Clockify

| Key             | Action                                      |
| --------------- | ------------------------------------------- |
| Shift+Alt+Enter | open / close the launcher                   |
| Enter           | start the selected entry (stop it if it's running) |
| Shift+Enter     | start a new entry from the typed text       |
| Ctrl+S          | stop the running timer                      |
| Ctrl+R          | reload                                      |
| Esc             | close                                       |

Recent entries (last 200) are de-duplicated by description, project, task,
tags and billable, newest first, with when you last worked on them. Typing
filters them by description, project, task, tags and client; the last row
always offers a new entry from the typed text. In it, `@proj` picks the
first matching project and `#tag` adds tags (prefix/substring match, spaces
in names ignored), e.g. `Standup @falcon #meeting`. Starting stops the
running timer at the same instant, so there are no gaps.

The last fetched entries, projects and tags are cached in
`~/.cache/quick-launcher/clockify.json`, so the list shows up right away
(even after a restart) while it refreshes in the background.

Needs an API key (Clockify → Profile settings → API). Workspaces on a
regional server need the matching API URL, e.g. `https://euc1.clockify.me/api/v1`.

## Settings

Shortcuts, vaults, clipboard and typing behaviour, Clockify API key/URL:
`gnome-extensions prefs quick-launcher@julian.falcondev.de`

## Development

```
src/
  extension.ts          enable/disable, keybindings
  prefs.ts              Adwaita preferences
  lib/launcher.ts       the popup (row pooling, password prompt mode)
  lib/search.ts         Bitwarden-style token search
  lib/output.ts         clipboard, virtual keyboard, timers
  passwords/            Vault interface, rbw + 1Password, pinentry D-Bus service
  clockify/             API client, task grouping and @project/#tag parsing
  bin/pinentry.ts       the pinentry bridge rbw runs
```

TypeScript with types from [`@girs`](https://github.com/gjsify/ts-for-gir),
compiled file-by-file with `tsc` (no bundler), so `dist/` mirrors `src/`.

```sh
pnpm check      # typecheck, lint, unit tests
pnpm build      # dist/
journalctl -f -o cat /usr/bin/gnome-shell   # logs
```
