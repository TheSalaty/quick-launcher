import type Gio from 'gi://Gio';

import {CommandError, findProgram, run, type RunOptions} from '../lib/subprocess.ts';
import {VaultLockedError, type ItemKind, type Prompter, type SecretField, type Vault, type VaultItem} from './vault.ts';

const KINDS: Record<string, ItemKind> = {
    Login: 'login',
    Card: 'card',
    Identity: 'identity',
    Note: 'note',
    SshKey: 'ssh',
};

interface RbwEntry {
    id: string;
    name?: string | null;
    user?: string | null;
    folder?: string | null;
    uris?: string[] | null;
    type?: string | null;
}

/** Bitwarden through rbw, whose agent keeps the vault decrypted and answers instantly. */
export class RbwVault implements Vault {
    readonly id = 'bitwarden';
    readonly name = 'Bitwarden';
    readonly logo = 'bitwarden.svg';
    readonly logoClass = 'ql-source-bitwarden';
    readonly color = '#175ddc';
    readonly website = 'https://github.com/doy/rbw#installation';
    readonly enabledKey = 'bitwarden-enabled';
    readonly #settings: Gio.Settings;

    constructor(settings: Gio.Settings) {
        this.#settings = settings;
    }

    get enabled(): boolean {
        return this.#settings.get_boolean(this.enabledKey);
    }

    get installed(): boolean {
        return findProgram(this.#settings.get_string('rbw-path') || 'rbw') !== null;
    }

    /** rbw needs the account's email before it can log in. */
    async setUp(prompter: Prompter): Promise<boolean> {
        const {stdout} = await this.#run(['config', 'show'], {check: false});
        try {
            if (JSON.parse(stdout).email)
                return true;
        } catch {}
        const email = (await prompter.askText('Bitwarden email',
            'Your Bitwarden account. For a self-hosted server, run rbw config set base_url first'))?.trim();
        if (!email)
            return false;
        await this.#run(['config', 'set', 'email', email]);
        return true;
    }

    #run(args: string[], options?: RunOptions) {
        return run([this.#settings.get_string('rbw-path') || 'rbw', ...args], options);
    }

    async isUnlocked(): Promise<boolean> {
        const {ok} = await this.#run(['unlocked'], {check: false});
        return ok;
    }

    async unlock(prompter: Prompter): Promise<boolean> {
        // With the pinentry bridge, rbw's password prompt is answered by
        // our launcher over D-Bus, so it can stay open. Otherwise the
        // configured pinentry needs the keyboard.
        const unlock = () => this.#run(['unlock'], {check: false});
        const {ok, stderr} = this.#settings.get_boolean('rbw-pinentry-bridge')
            ? await unlock()
            : await prompter.stepAside(unlock);

        if (!ok && !/cancel/i.test(stderr))
            throw new CommandError(stderr.trim().split('\n').at(-1) || 'rbw unlock failed', stderr);
        return ok;
    }

    async lock() {
        await this.#run(['lock'], {check: false});
    }

    async sync() {
        await this.#run(['sync']);
    }

    async list(): Promise<VaultItem[]> {
        const {stdout} = await this.#run(['list', '--raw']);
        return (JSON.parse(stdout) as RbwEntry[]).map(e => ({
            id: `${this.id}:${e.id}`,
            nativeId: e.id,
            vault: this,
            name: e.name ?? '',
            user: e.user ?? '',
            location: e.folder ?? '',
            urls: e.uris ?? [],
            kind: KINDS[e.type ?? 'Login'] ?? 'other',
        }));
    }

    async secret(item: VaultItem, field: SecretField): Promise<string> {
        if (!await this.isUnlocked())
            throw new VaultLockedError(this);

        if (field === 'totp')
            return (await this.#run(['code', item.nativeId])).stdout.trim();

        const {stdout} = await this.#run(['get', item.nativeId]);
        return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
    }

    destroy() {}
}
