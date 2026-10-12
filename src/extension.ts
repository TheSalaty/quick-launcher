import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Clockify} from './clockify/clockify.ts';
import {Timers} from './lib/output.ts';
import {Passwords} from './passwords/passwords.ts';

interface Launcher {
    toggle(): void;
    destroy(): void;
}

export default class QuickLauncherExtension extends Extension {
    #timers: Timers | null = null;
    #launchers = new Map<string, Launcher>();

    override enable() {
        const settings = this.getSettings();
        this.#timers = new Timers();
        this.#launchers.set('shortcut', new Passwords(settings, this.#timers));
        this.#launchers.set('clockify-shortcut', new Clockify(settings));

        for (const [key, launcher] of this.#launchers) {
            Main.wm.addKeybinding(key, settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => launcher.toggle());
        }
    }

    override disable() {
        for (const [key, launcher] of this.#launchers) {
            Main.wm.removeKeybinding(key);
            launcher.destroy();
        }
        this.#launchers.clear();
        this.#timers?.clear();
        this.#timers = null;
    }
}
