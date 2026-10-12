import Gio from 'gi://Gio';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

export class RbwError extends Error {}

export class Rbw {
    constructor(getPath) {
        this._getPath = getPath;
    }

    async _run(args, {check = true} = {}) {
        const argv = [this._getPath(), ...args];
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            throw new RbwError(`Could not run ${argv[0]}: ${e.message}`);
        }

        const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
        const ok = proc.get_successful();
        if (check && !ok)
            throw new RbwError(stderr.trim() || `rbw ${args[0]} failed`);
        return {ok, stdout, stderr};
    }

    async isUnlocked() {
        const {ok} = await this._run(['unlocked'], {check: false});
        return ok;
    }

    /** Prompts for the master password via pinentry. Resolves false if cancelled. */
    async unlock() {
        const {ok} = await this._run(['unlock'], {check: false});
        return ok;
    }

    sync() {
        return this._run(['sync']);
    }

    async list() {
        const {stdout} = await this._run(['list', '--raw']);
        return JSON.parse(stdout).map(e => ({
            id: e.id,
            name: e.name ?? '',
            user: e.user ?? '',
            folder: e.folder ?? '',
            uris: e.uris ?? [],
            type: e.type ?? 'Login',
        }));
    }

    async password(id) {
        const {stdout} = await this._run(['get', id]);
        return stripNewline(stdout);
    }

    async totp(id) {
        const {stdout} = await this._run(['code', id]);
        return stdout.trim();
    }
}

function stripNewline(text) {
    return text.endsWith('\n') ? text.slice(0, -1) : text;
}
