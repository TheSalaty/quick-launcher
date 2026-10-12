import type Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Launcher, type Keys, type RowContent} from '../lib/launcher.ts';
import {notifyError, osd, SecretClipboard, Timers, Typist} from '../lib/output.ts';
import {SearchIndex, type Field} from '../lib/search.ts';
import {OnePasswordVault} from './onepassword.ts';
import {PinentryService, type PinRequest} from './pinentry.ts';
import {RbwVault} from './rbw.ts';
import {VaultLockedError, type ItemKind, type Prompter, type Vault, type VaultItem} from './vault.ts';

type Status = 'checking' | 'locked' | 'unlocking' | 'unlocked' | 'error';

interface VaultState {
    status: Status;
    error: string;
    items: VaultItem[];
    /** Bumped on every reload, so a slow, stale response is dropped. */
    generation: number;
}

/** Shown for a vault that is locked, unlocking or failing */
interface VaultRow {
    id: string;
    vault: Vault;
    isVaultRow: true;
}

type Entry = VaultItem | VaultRow;

type What = 'password' | 'user' | 'totp' | 'login';

const LABELS: Record<What, string> = {
    password: 'Password',
    user: 'Username',
    totp: 'TOTP code',
    login: 'Login',
};

const KIND_ICONS: Record<ItemKind, string> = {
    login: 'dialog-password-symbolic',
    card: 'auth-smartcard-symbolic',
    identity: 'avatar-default-symbolic',
    note: 'text-x-generic-symbolic',
    ssh: 'network-server-symbolic',
    other: 'dialog-password-symbolic',
};

const HINTS = '⏎ copy password   ⇧⏎ type   ⌃⏎ type login   Alt+U user   Alt+T TOTP   ⌃R sync   ⌃L lock';

function isVaultRow(entry: Entry): entry is VaultRow {
    return 'isVaultRow' in entry;
}

function stripScheme(uri: string): string {
    return uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '');
}

function searchFields(item: VaultItem): Field[] {
    return [
        [10, item.name],
        [5, item.user],
        [2, item.urls.map(stripScheme)],
        [1, item.location],
        [1, item.vault.name],
    ];
}

/**
 * Actions: copy-password, type-password, copy-user, type-user, copy-totp,
 * type-totp, type-login.
 */
function itemAction({enter, char, ctrl, shift, alt}: Keys): string | null {
    if (enter)
        return ctrl ? 'type-login' : shift ? 'type-password' : 'copy-password';
    if (!alt || ctrl)
        return null;

    const verb = shift ? 'type' : 'copy';
    const actions: Record<string, string> = {
        p: `${verb}-password`,
        u: `${verb}-user`,
        t: `${verb}-totp`,
        a: 'type-login',
    };
    return actions[char] ?? null;
}

/** One search over all password managers; locked ones can be unlocked in place. */
export class Passwords {
    readonly #settings: Gio.Settings;
    readonly #vaults: Vault[];
    readonly #states = new Map<Vault, VaultState>();
    readonly #clipboard: SecretClipboard;
    readonly #typist: Typist;
    readonly #launcher: Launcher<Entry>;
    readonly #prompter: Prompter;
    readonly #settingsIds: number[];
    #index = new SearchIndex<VaultItem>([], searchFields);
    #pinentry: PinentryService | null = null;
    #destroyed = false;

    constructor(settings: Gio.Settings, timers: Timers) {
        this.#settings = settings;
        this.#vaults = [new RbwVault(settings), new OnePasswordVault(settings)];
        for (const vault of this.#vaults)
            this.#states.set(vault, {status: 'checking', error: '', items: [], generation: 0});

        this.#clipboard = new SecretClipboard(settings, timers);
        this.#typist = new Typist(settings, timers);
        this.#launcher = new Launcher<Entry>({
            icon: 'system-search-symbolic',
            placeholder: 'Search passwords…',
            hints: HINTS,
            search: query => this.#search(query),
            describe: entry => this.#describe(entry),
            actionFor: (entry, keys) => isVaultRow(entry)
                ? keys.enter ? 'unlock' : null
                : itemAction(keys),
            commands: {
                r: () => void this.#sync(),
                l: () => void this.#lockAll(),
            },
            onActivate: (entry, action) => isVaultRow(entry)
                ? void this.#unlock(entry.vault)
                : void this.#perform(entry, action),
        });

        this.#prompter = {
            askSecret: (prompt, description) => this.#launcher.askSecret({prompt, description}),
            stepAside: task => this.#stepAside(task),
        };

        this.#settingsIds = [
            settings.connect('changed::rbw-pinentry-bridge', () => this.#updatePinentry()),
            settings.connect('changed::bitwarden-enabled', () => this.#reloadAll()),
            settings.connect('changed::onepassword-enabled', () => this.#reloadAll()),
        ];
        this.#updatePinentry();
    }

    destroy() {
        this.#destroyed = true;
        for (const id of this.#settingsIds)
            this.#settings.disconnect(id);
        this.#pinentry?.destroy();
        this.#clipboard.clearNow();
        this.#typist.destroy();
        this.#launcher.destroy();
        for (const vault of this.#vaults)
            vault.destroy();
    }

    get #enabledVaults(): Vault[] {
        return this.#vaults.filter(v => v.enabled);
    }

    toggle() {
        if (this.#launcher.isOpen) {
            this.#launcher.close();
            return;
        }
        // Show what we have right away; the vaults are checked in the background.
        this.#open();
        this.#reloadAll();
    }

    #open() {
        this.#launcher.open({
            query: this.#settings.get_string('last-query'),
            selectId: this.#settings.get_string('last-entry-id'),
        });
        this.#showStatus();
    }

    #search(query: string): Entry[] {
        const items: Entry[] = this.#index.search(query);
        const rows: VaultRow[] = this.#enabledVaults
            .filter(v => ['locked', 'unlocking', 'error'].includes(this.#state(v).status))
            .map(vault => ({id: `vault:${vault.id}`, vault, isVaultRow: true as const}));

        // Locked vaults come first while browsing, but must not steal Enter from a search hit.
        return query.trim() && items.length ? [...items, ...rows] : [...rows, ...items];
    }

    #describe(entry: Entry): RowContent {
        if (!isVaultRow(entry)) {
            return {
                icon: KIND_ICONS[entry.kind],
                title: entry.name || '(unnamed)',
                subtitle: [entry.user, entry.location].filter(Boolean).join('  ·  '),
                badge: {text: entry.vault.name, styleClass: entry.vault.badgeClass},
            };
        }

        const {vault} = entry;
        const {status, error} = this.#state(vault);
        const badge = {text: vault.name, styleClass: vault.badgeClass};
        switch (status) {
        case 'unlocking':
            return {icon: 'content-loading-symbolic', title: `Unlocking ${vault.name}…`, badge, dim: true};
        case 'error':
            return {
                icon: 'dialog-warning-symbolic',
                title: `${vault.name} is unavailable`,
                subtitle: `${error}  ·  ⏎ retry`,
                badge,
                dim: true,
            };
        default:
            return {icon: 'system-lock-screen-symbolic', title: `Unlock ${vault.name}`, subtitle: 'Locked  ·  ⏎ unlock', badge};
        }
    }

    #state(vault: Vault): VaultState {
        return this.#states.get(vault)!;
    }

    #setState(vault: Vault, changes: Partial<VaultState>) {
        Object.assign(this.#state(vault), changes);
        if ('items' in changes || 'status' in changes) {
            this.#index = new SearchIndex(
                this.#enabledVaults
                    .flatMap(v => this.#state(v).items)
                    .sort((a, b) => a.name.localeCompare(b.name)),
                searchFields);
        }
        this.#launcher.refresh();
        this.#showStatus();
    }

    #showStatus() {
        const vaults = this.#enabledVaults;
        if (vaults.length === 0) {
            this.#launcher.setStatus('No password manager enabled — see the extension preferences');
            return;
        }
        const checking = vaults.filter(v => this.#state(v).status === 'checking' && !this.#state(v).items.length);
        this.#launcher.setStatus(checking.length ? `Loading ${checking.map(v => v.name).join(' and ')}…` : null);
    }

    #reloadAll() {
        for (const vault of this.#vaults) {
            if (vault.enabled)
                void this.#reload(vault);
            else
                this.#setState(vault, {status: 'checking', items: []});
        }
    }

    async #reload(vault: Vault) {
        const generation = ++this.#state(vault).generation;
        const current = () => !this.#destroyed && this.#state(vault).generation === generation;

        try {
            if (!await vault.isUnlocked()) {
                if (current() && this.#state(vault).status !== 'unlocking')
                    this.#setState(vault, {status: 'locked', items: []});
                return;
            }
            const items = await vault.list();
            if (current())
                this.#setState(vault, {status: 'unlocked', error: '', items});
        } catch (e) {
            if (!current())
                return;
            if (e instanceof VaultLockedError) {
                this.#setState(vault, {status: 'locked', items: []});
                return;
            }
            console.error(`quick-launcher: Could not load ${vault.name}`, e);
            this.#setState(vault, {status: 'error', error: (e as Error).message, items: []});
        }
    }

    async #unlock(vault: Vault) {
        const state = this.#state(vault);
        if (state.status === 'unlocking')
            return;
        if (state.status === 'error') {
            await this.#reload(vault);
            if (this.#state(vault).status !== 'locked')
                return;
        }

        this.#setState(vault, {status: 'unlocking'});
        try {
            const ok = await vault.unlock(this.#prompter);
            if (this.#destroyed)
                return;
            this.#setState(vault, {status: ok ? 'checking' : 'locked'});
            if (ok)
                await this.#reload(vault);
        } catch (e) {
            if (!this.#destroyed)
                this.#setState(vault, {status: 'error', error: (e as Error).message});
        }
    }

    /** Hides the launcher while another prompt needs the keyboard, then brings it back. */
    async #stepAside<R>(task: () => Promise<R>): Promise<R> {
        const wasOpen = this.#launcher.isOpen;
        const query = this.#launcher.query;
        const selectId = this.#launcher.selected?.id;
        this.#launcher.close();
        try {
            return await task();
        } finally {
            if (wasOpen && !this.#destroyed)
                this.#launcher.open({query, selectId});
        }
    }

    async #sync() {
        this.#launcher.setStatus('Syncing…');
        await Promise.all(this.#enabledVaults
            .filter(v => this.#state(v).status === 'unlocked')
            .map(async v => {
                try {
                    await v.sync();
                } catch (e) {
                    notifyError(`Could not sync ${v.name}`, e);
                }
            }));
        this.#reloadAll();
    }

    async #lockAll() {
        await Promise.all(this.#enabledVaults.map(v => v.lock().catch(e => notifyError(`Could not lock ${v.name}`, e))));
        for (const vault of this.#enabledVaults)
            this.#setState(vault, {status: 'locked', items: []});
        osd('system-lock-screen-symbolic', 'Vaults locked');
    }

    #updatePinentry() {
        const wanted = this.#settings.get_boolean('rbw-pinentry-bridge');
        if (wanted && !this.#pinentry) {
            this.#pinentry = new PinentryService(request => this.#askPin(request));
        } else if (!wanted && this.#pinentry) {
            this.#pinentry.destroy();
            this.#pinentry = null;
        }
    }

    #askPin({title, description, prompt, error}: PinRequest): Promise<string | null> {
        // rbw sends title "rbw" and prompt "Master Password".
        const name = title === 'rbw' ? 'Bitwarden' : title;
        return this.#launcher.askSecret({
            prompt: [name, (prompt || 'password').toLowerCase()].filter(Boolean).join(' '),
            description: [error, description].filter(Boolean).join('\n') || undefined,
        });
    }

    async #perform(item: VaultItem, action: string) {
        this.#settings.set_string('last-query', this.#launcher.query);
        this.#settings.set_string('last-entry-id', item.id);
        this.#launcher.close();

        const [verb, what] = action.split('-') as ['copy' | 'type', What];
        try {
            const value = await this.#valueOf(item, what);
            if (this.#destroyed)
                return;
            if (!value) {
                Main.notify(item.vault.name, `${item.name} has no ${LABELS[what].toLowerCase()}`);
                return;
            }

            if (verb === 'copy') {
                this.#clipboard.copy(value);
                osd('edit-copy-symbolic', `${LABELS[what]} copied from ${item.vault.name}`);
            } else {
                const submit = (what === 'password' || what === 'login') &&
                    this.#settings.get_boolean('submit-after-password');
                await this.#typist.type(submit ? `${value}\n` : value);
            }
        } catch (e) {
            if (e instanceof VaultLockedError) {
                this.#setState(item.vault, {status: 'locked', items: []});
                Main.notify(item.vault.name, 'The vault is locked. Open the launcher to unlock it.');
                return;
            }
            notifyError(`Could not get ${LABELS[what].toLowerCase()} for ${item.name}`, e);
        }
    }

    async #valueOf(item: VaultItem, what: What): Promise<string> {
        switch (what) {
        case 'user':
            return item.user;
        case 'password':
        case 'totp':
            return item.vault.secret(item, what);
        case 'login': {
            const password = await item.vault.secret(item, 'password');
            return item.user ? `${item.user}\t${password}` : password;
        }
        }
    }
}
