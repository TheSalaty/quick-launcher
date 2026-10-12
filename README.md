# Quick Launcher

A GNOME Shell extension (GNOME 48–50, Wayland) with two Spotlight-style popups:

- **Bitwarden** (replaces rofi-rbw): searches your vault through
  [rbw](https://github.com/doy/rbw) and copies or types the selected secret.
- **Clockify**: searches your recent time entries and starts a new timer
  with the same description, project, task and tags, or a new one.

Typing uses a Clutter virtual keyboard inside the shell, so no ydotool /
wtype / uinput daemon is needed. Copied secrets are cleared after 30 s
(only if the clipboard still holds them) and removed from Clipboard
Indicator's history.

## Install

```sh
./install.sh
gnome-extensions enable quick-launcher@julian.falcondev.de
```

On Wayland, log out and back in once so the shell picks up the new extension.
`install.sh` also removes the old `bitwarden-launcher@julian.falcondev.de`
link and migrates its settings.

## Bitwarden keys

| Key                | Action                         |
| ------------------ | ------------------------------ |
| Ctrl+Shift+Enter   | open / close the launcher      |
| Enter              | copy password                  |
| Shift+Enter        | type password, Enter           |
| Ctrl+Enter         | type username, Tab, password, Enter |
| Alt+P / Alt+U / Alt+T | copy password / username / TOTP (add Shift to type) |
| Up/Down, Tab, Ctrl+N/P | move selection             |
| Ctrl+R             | `rbw sync` and reload          |
| Esc                | close                          |

The last query and the last-used entry are restored on open, with the
query pre-selected so you can just press Enter or start typing.

Search works like the Bitwarden clients: every word is matched as a
substring against name (weighted most), username, URIs and folder, so entries
matching more words rank first.

## Clockify keys

| Key                | Action                                     |
| ------------------ | ------------------------------------------ |
| Shift+Alt+Enter    | open / close the launcher                  |
| Enter              | start the selected entry (or the "new" row) |
| Shift+Enter        | start a new entry from the typed text      |
| Ctrl+S             | stop the running timer                     |
| Ctrl+R             | reload                                     |
| Esc                | close                                      |

Recent entries (last 200) are de-duplicated by description, project, task,
tags and billable, newest first. Typing filters them by description, project,
task, tags and client; the last row always offers a new entry from the typed
text. In it, `@proj` picks the first matching project and `#tag` adds tags
(prefix/substring match, spaces in names ignored), e.g.
`Standup @falcon #meeting`. Starting stops the running timer at the same
instant, so there are no gaps.

Like the Bitwarden launcher, it restores the last query and entry on open.
The last fetched entries, projects and tags are cached in
`~/.cache/quick-launcher/clockify.json`, so the list shows up right away
(even after a restart) while it refreshes in the background.

Needs an API key (Clockify → Profile settings → API). Workspaces on a
regional server need the matching API URL, e.g. `https://euc1.clockify.me/api/v1`.

## Settings

Shortcuts, rbw path, clear timeout, typing delay, Clockify API key/URL:
`gnome-extensions prefs quick-launcher@julian.falcondev.de`
