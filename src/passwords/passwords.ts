import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {Action, Item, Launcher, Section, View} from '../lib/launcher.ts';
import {notifyError, osd, SecretClipboard, Typist, type Timers} from '../lib/output.ts';
import type {Recents} from '../lib/recents.ts';
import {SearchIndex, type Field} from '../lib/search.ts';
import {setPinentryBridge} from './bridge.ts';
import {OnePasswordVault} from './onepassword.ts';
import {PinentryService, type PinRequest} from './pinentry.ts';
import {RbwVault} from './rbw.ts';
import {VaultLockedError, type ItemKind, type Prompter, type Vault, type VaultItem} from './vault.ts';

export type VaultStatus = 'checking' | 'locked' | 'unlocking' | 'unlocked' | 'error';

/** A vault as onboarding shows it */
export interface VaultInfo {
    vault: Vault;
    logo: Gio.Icon;
    status: VaultStatus;
    error: string;
    items: number;
    /** Self-hosted server, '' for the default */
    server: string;
}

interface VaultState {
    status: VaultStatus;
    error: string;
    items: VaultItem[];
    /** Bumped on every reload, so a slow, stale response is dropped. */
    generation: number;
}

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

export const PASSWORDS_COLOR = '#3584e4';
const RECENT_PREFIX = 'password:';

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

/** Bitwarden and 1Password behind one search; locked vaults can be unlocked in place. */
export class Passwords {
    readonly #settings: Gio.Settings;
    readonly #launcher: Launcher;
    readonly #recents: Recents;
    readonly #vaults: Vault[];
    readonly #states = new Map<Vault, VaultState>();
    readonly #logos = new Map<Vault, Gio.Icon>();
    readonly #servers = new Map<Vault, string>();
    readonly #clipboard: SecretClipboard;
    readonly #typist: Typist;
    readonly #prompter: Prompter;
    readonly #settingsIds: number[];
    readonly #extensionDir: Gio.File;
    #index = new SearchIndex<VaultItem>([], searchFields);
    #pinentry: PinentryService | null = null;
    #destroyed = false;

    readonly view: View;

    constructor(settings: Gio.Settings, timers: Timers, extensionDir: Gio.File, launcher: Launcher, recents: Recents) {
        this.#settings = settings;
        this.#extensionDir = extensionDir;
        const iconsDir = extensionDir.get_child('icons');
        this.#launcher = launcher;
        this.#recents = recents;
        this.#vaults = [new RbwVault(settings), new OnePasswordVault(settings)];
        for (const vault of this.#vaults) {
            this.#logos.set(vault, new Gio.FileIcon({file: iconsDir.get_child(vault.logo)}));
            this.#states.set(vault, {status: 'checking', error: '', items: [], generation: 0});
        }
        this.#clipboard = new SecretClipboard(settings, timers);
        this.#typist = new Typist(settings, timers);
        this.#prompter = {
            askSecret: (prompt, description) => this.#launcher.askSecret({prompt, description}),
            askText: (prompt, description) => this.#launcher.ask({prompt, description, secret: false, action: 'Continue'}),
            stepAside: task => this.#stepAside(task),
        };

        this.view = {
            title: 'Passwords',
            icon: 'dialog-password-symbolic',
            placeholder: 'Search passwords…',
            search: query => this.#viewSections(query),
            actions: () => this.#viewActions(),
        };

        this.#settingsIds = [
            settings.connect('changed::rbw-pinentry-bridge', () => this.#updatePinentry()),
            settings.connect('changed::bitwarden-enabled', () => this.reload()),
            settings.connect('changed::onepassword-enabled', () => this.reload()),
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
        for (const vault of this.#vaults)
            vault.destroy();
    }

    get #enabledVaults(): Vault[] {
        return this.#vaults.filter(v => v.enabled);
    }

    // --- What the launcher shows ---

    /** Best matches for the start view; nothing for an empty query. */
    search(query: string, limit: number): Item[] {
        if (!query.trim())
            return [];
        return this.#index.search(query, {all: true}).slice(0, limit).map(item => this.#item(item));
    }

    /** "Unlock Bitwarden" rows for vaults that are locked or failing. */
    vaultRows(): Item[] {
        return this.#enabledVaults
            .filter(v => ['locked', 'unlocking', 'error'].includes(this.#state(v).status))
            .map(vault => this.#vaultRow(vault));
    }

    /** Commands for the start view. */
    commands(): Item[] {
        const command = (id: string, icon: string, title: string, subtitle: string, run: () => void): Item => ({
            id: `command:${id}`,
            icon: {name: icon, color: PASSWORDS_COLOR},
            title,
            subtitle,
            accessory: 'Command',
            actions: [{title: id === 'passwords' ? 'Open' : title, icon, run}],
        });
        return [
            command('passwords', 'dialog-password-symbolic', 'Search Passwords',
                this.#enabledVaults.map(v => v.name).join(' & ') || 'No vault enabled',
                () => this.#launcher.push(this.view)),
            command('lock-vaults', 'system-lock-screen-symbolic', 'Lock Vaults', 'Passwords', () => void this.#lockAll()),
            command('sync-vaults', 'view-refresh-symbolic', 'Sync Vaults', 'Passwords', () => void this.#sync()),
        ];
    }

    /** A recently used item, if its vault is unlocked. */
    recent(id: string): Item | null {
        if (!id.startsWith(RECENT_PREFIX))
            return null;
        const itemId = id.slice(RECENT_PREFIX.length);
        const item = this.#index.items.find(i => i.id === itemId);
        return item ? this.#item(item) : null;
    }

    /** Every vault, including turned off and not installed ones. */
    vaults(): VaultInfo[] {
        return this.#vaults.map(vault => {
            const {status, error, items} = this.#state(vault);
            return {vault, logo: this.#logos.get(vault)!, status, error, items: items.length, server: this.#servers.get(vault) ?? ''};
        });
    }

    /** Turns a vault on, sets it up if needed, and unlocks it. */
    async connect(vault: Vault) {
        try {
            this.#settings.set_boolean(vault.enabledKey, true);
            if (vault.setUp && !await vault.setUp(this.#prompter))
                return;
            // Ask for rbw's master password right here instead of in a separate pinentry window.
            if (vault instanceof RbwVault && !this.#settings.get_boolean('rbw-pinentry-bridge')) {
                await setPinentryBridge(this.#settings, true, this.#extensionDir).catch(e =>
                    console.warn('quick-launcher: Could not set up the rbw pinentry bridge', e));
            }
            if (await vault.isUnlocked()) {
                await this.#reload(vault);
                return;
            }
        } catch (e) {
            this.#setState(vault, {status: 'error', error: (e as Error).message});
            return;
        }
        await this.#unlock(vault);
    }

    /** Asks for another server, then signs in there. */
    async changeServer(vault: Vault) {
        if (!vault.askServer || !vault.setServer)
            return;
        try {
            const server = await vault.askServer(this.#prompter);
            if (server === null)
                return;
            await vault.setServer(server);
        } catch (e) {
            this.#setState(vault, {status: 'error', error: (e as Error).message});
            return;
        }
        this.#setState(vault, {status: 'locked', items: []});
        await this.connect(vault);
    }

    setEnabled(vault: Vault, enabled: boolean) {
        this.#settings.set_boolean(vault.enabledKey, enabled);
    }

    #viewSections(query: string): Section[] {
        const items = this.#index.search(query).map(item => this.#item(item));
        const locked = this.vaultRows();
        // Locked vaults come first while browsing, but must not steal Enter from a search hit.
        return query.trim() && items.length
            ? [{items}, {title: 'Locked', items: locked}]
            : [{items: locked}, {items}];
    }

    #viewActions(): Action[] {
        return [
            {title: 'Sync Vaults', icon: 'view-refresh-symbolic', shortcut: 'sync-vaults', run: () => void this.#sync()},
            {title: 'Lock Vaults', icon: 'system-lock-screen-symbolic', shortcut: 'lock-vaults', run: () => void this.#lockAll()},
        ];
    }

    #item(item: VaultItem): Item {
        const run = (verb: 'copy' | 'type', what: What) => () => void this.#perform(item, verb, what);
        return {
            id: item.id,
            icon: {name: KIND_ICONS[item.kind]},
            title: item.name || '(unnamed)',
            subtitle: [item.user, item.location].filter(Boolean).join('  ·  '),
            source: {icon: this.#logos.get(item.vault)!, styleClass: item.vault.logoClass},
            actions: [
                {title: 'Copy Password', icon: 'edit-copy-symbolic', shortcut: 'copy-password', run: run('copy', 'password')},
                {title: 'Copy Username', icon: 'avatar-default-symbolic', shortcut: 'copy-username', run: run('copy', 'user')},
                {title: 'Type Password', icon: 'input-keyboard-symbolic', shortcut: 'type-password', run: run('type', 'password')},
                {title: 'Type Username and Password', icon: 'input-keyboard-symbolic', shortcut: 'type-login', run: run('type', 'login')},
                {title: 'Copy TOTP Code', icon: 'preferences-system-time-symbolic', shortcut: 'copy-totp', run: run('copy', 'totp')},
                {title: 'Type Username', icon: 'input-keyboard-symbolic', shortcut: 'type-username', run: run('type', 'user')},
                {title: 'Type TOTP Code', icon: 'input-keyboard-symbolic', shortcut: 'type-totp', run: run('type', 'totp')},
            ],
        };
    }

    #vaultRow(vault: Vault): Item {
        const {status, error} = this.#state(vault);
        const actions: Action[] = [
            {title: status === 'error' ? 'Retry' : 'Unlock', icon: 'system-lock-screen-symbolic', run: () => void this.#unlock(vault)},
            ...vault.askServer ? [{
                title: 'Use Another Server…', icon: 'network-server-symbolic', shortcut: 'vault-server',
                run: () => void this.changeServer(vault),
            } satisfies Action] : [],
        ];
        const base = {
            id: `vault:${vault.id}`,
            source: {icon: this.#logos.get(vault)!, styleClass: vault.logoClass},
            actions,
        };
        switch (status) {
        case 'unlocking':
            return {...base, icon: {name: 'content-loading-symbolic'}, title: `Unlocking ${vault.name}…`, dim: true};
        case 'error':
            return {...base, icon: {name: 'dialog-warning-symbolic'}, title: `${vault.name} is unavailable`, subtitle: error, dim: true};
        default:
            return {...base, icon: {name: 'system-lock-screen-symbolic'}, title: `Unlock ${vault.name}`, subtitle: 'Locked'};
        }
    }

    // --- Vault state ---

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
    }

    /** Checks every enabled vault in the background and loads its items. */
    reload() {
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
        vault.server?.().then(server => {
            if (!this.#destroyed && server !== (this.#servers.get(vault) ?? '')) {
                this.#servers.set(vault, server);
                this.#launcher.refresh();
            }
        }).catch(() => {});

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
        const restore = this.#launcher.stack;
        this.#launcher.close();
        try {
            return await task();
        } finally {
            if (wasOpen && !this.#destroyed && restore.length)
                this.#launcher.open(restore[0].view, {restore});
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
        this.#launcher.setStatus(null);
        this.reload();
    }

    async #lockAll() {
        await Promise.all(this.#enabledVaults.map(v => v.lock().catch(e => notifyError(`Could not lock ${v.name}`, e))));
        for (const vault of this.#enabledVaults)
            this.#setState(vault, {status: 'locked', items: []});
        this.#clipboard.clear();
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
            description: [error, description].filter(Boolean).join(' · ') || undefined,
        });
    }

    // --- Using an item ---

    async #perform(item: VaultItem, verb: 'copy' | 'type', what: What) {
        this.#recents.add(`${RECENT_PREFIX}${item.id}`);
        this.#launcher.close();
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
