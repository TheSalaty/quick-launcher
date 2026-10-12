import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Launcher} from './launcher.js';
import {SecretClipboard, Typist} from './output.js';
import {Rbw} from './rbw.js';
import {prepare, search} from './search.js';

const LABELS = {
    password: 'Password',
    user: 'Username',
    totp: 'TOTP code',
    autotype: 'Login',
};

const TYPE_ICONS = {
    Login: 'dialog-password-symbolic',
    Card: 'auth-smartcard-symbolic',
    Identity: 'avatar-default-symbolic',
    Note: 'text-x-generic-symbolic',
    SshKey: 'network-server-symbolic',
};

const HINTS = '⏎ copy password   ⇧⏎ type password ⏎   ⌃⏎ type user ⇥ password ⏎   ' +
    'Alt+U user   Alt+T TOTP   (+⇧ types)   ⌃R sync';

function stripScheme(uri) {
    return uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '');
}

function searchFields(entry) {
    return [
        [10, entry.name],
        [5, entry.user],
        [2, entry.uris.map(stripScheme)],
        [1, entry.folder],
    ];
}

/**
 * Actions: copy-password, type-password, copy-user, type-user,
 * copy-totp, type-totp, autotype.
 */
function actionFor({enter, char, ctrl, shift, alt}) {
    if (enter)
        return ctrl ? 'autotype' : shift ? 'type-password' : 'copy-password';
    if (!alt || ctrl)
        return null;

    const verb = shift ? 'type' : 'copy';
    const actions = {
        p: `${verb}-password`,
        u: `${verb}-user`,
        t: `${verb}-totp`,
        a: 'autotype',
    };
    return actions[char] ?? null;
}

/** Searches the vault through rbw and copies or types secrets. */
export class Bitwarden {
    constructor(settings, timers) {
        this._settings = settings;
        this._rbw = new Rbw(() => this._settings.get_string('rbw-path') || 'rbw');
        this._clipboard = new SecretClipboard(settings, timers);
        this._typist = new Typist(settings, timers);
        this._launcher = new Launcher({
            icon: 'dialog-password-symbolic',
            placeholder: 'Search vault…',
            hints: HINTS,
            search,
            describe: entry => ({
                icon: TYPE_ICONS[entry.type] ?? TYPE_ICONS.Login,
                title: entry.name || '(unnamed)',
                subtitle: [entry.user, entry.folder].filter(Boolean).join('  ·  '),
            }),
            actionFor,
            commands: {r: () => this._sync()},
            onActivate: (entry, action) => this._perform(entry, action),
        });
        this._entries = [];
        this._opening = false;
    }

    destroy() {
        this._clipboard.clearNow();
        this._typist.destroy();
        this._launcher.destroy();
        this._launcher = null;
    }

    async toggle() {
        if (this._launcher.isOpen) {
            this._launcher.close();
            return;
        }
        if (this._opening)
            return;

        this._opening = true;
        try {
            // Unlock before showing the popup so the pinentry prompt
            // doesn't have to fight with our modal grab.
            if (!await this._rbw.isUnlocked() && !await this._rbw.unlock())
                return;
            if (!this._launcher)
                return;

            this._launcher.setEntries(this._entries);
            this._launcher.setStatus(this._entries.length ? null : 'Loading…');
            this._launcher.open({
                query: this._settings.get_string('last-query'),
                selectedId: this._settings.get_string('last-entry-id'),
            });
            await this._reload();
        } catch (e) {
            this._fail('Could not open vault', e);
        } finally {
            this._opening = false;
        }
    }

    async _reload() {
        const entries = (await this._rbw.list())
            .sort((a, b) => a.name.localeCompare(b.name));
        if (!this._launcher)
            return;
        this._entries = prepare(entries, searchFields);
        this._launcher.setEntries(this._entries);
        this._launcher.setStatus(entries.length ? null : 'Vault is empty');
    }

    async _sync() {
        try {
            this._launcher.setStatus('Syncing…');
            await this._rbw.sync();
            await this._reload();
        } catch (e) {
            this._launcher?.setStatus(`Sync failed: ${e.message}`);
        }
    }

    async _perform(entry, action) {
        this._settings.set_string('last-query', this._launcher.query);
        this._settings.set_string('last-entry-id', entry.id);

        const [verb, what] = action === 'autotype' ? ['type', 'autotype'] : action.split('-');

        try {
            const value = await this._secretFor(entry, what);
            if (!this._launcher)
                return;
            if (!value) {
                Main.notify('Bitwarden', `${entry.name} has no ${LABELS[what].toLowerCase()}`);
                return;
            }

            if (verb === 'copy') {
                this._clipboard.copy(value);
                Main.osdWindowManager.showOne(Main.layoutManager.currentMonitor.index,
                    new Gio.ThemedIcon({name: 'edit-copy-symbolic'}),
                    `${LABELS[what]} copied`, null, undefined);
            } else {
                const submit = (what === 'password' || what === 'autotype') &&
                    this._settings.get_boolean('submit-after-password');
                await this._typist.type(submit ? `${value}\n` : value);
            }
        } catch (e) {
            this._fail(`Could not get ${LABELS[what].toLowerCase()} for ${entry.name}`, e);
        }
    }

    async _secretFor(entry, what) {
        switch (what) {
        case 'user':
            return entry.user;
        case 'password':
            return this._rbw.password(entry.id);
        case 'totp':
            return this._rbw.totp(entry.id);
        case 'autotype': {
            const password = await this._rbw.password(entry.id);
            return entry.user ? `${entry.user}\t${password}` : password;
        }
        }
        throw new Error(`Unknown field ${what}`);
    }

    _fail(message, error) {
        console.error(`quick-launcher: ${message}`, error);
        Main.notifyError(message, error.message);
    }
}
