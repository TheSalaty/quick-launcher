export type ItemKind = 'login' | 'card' | 'identity' | 'note' | 'ssh' | 'other';

export type SecretField = 'password' | 'totp';

export interface VaultItem {
    /** Unique across vaults: `${vault.id}:${nativeId}` */
    id: string;
    nativeId: string;
    vault: Vault;
    name: string;
    user: string;
    /** Folder (Bitwarden) or vault name (1Password) */
    location: string;
    urls: string[];
    kind: ItemKind;
}

/** Lets a vault ask for a master password without knowing about the UI. */
export interface Prompter {
    /** Asks inside the launcher; resolves null if cancelled. */
    askSecret(prompt: string, description?: string): Promise<string | null>;
    /** Hides the launcher while an external prompt (pinentry, 1Password app) is shown. */
    stepAside<R>(task: () => Promise<R>): Promise<R>;
}

export interface Vault {
    readonly id: string;
    readonly name: string;
    /** Extra style class for its badge */
    readonly badgeClass: string;
    readonly enabled: boolean;

    isUnlocked(): Promise<boolean>;
    /** Resolves false if the user cancelled. */
    unlock(prompter: Prompter): Promise<boolean>;
    lock(): Promise<void>;
    /** Item metadata only; secrets are fetched on demand. */
    list(): Promise<VaultItem[]>;
    sync(): Promise<void>;
    secret(item: VaultItem, field: SecretField): Promise<string>;
    destroy(): void;
}

/** Thrown when an operation failed because the vault is (again) locked. */
export class VaultLockedError extends Error {
    constructor(vault: Vault) {
        super(`${vault.name} is locked`);
        this.name = 'VaultLockedError';
    }
}
