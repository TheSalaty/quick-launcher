import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ExchangeRates} from './calc/rates.ts';
import {Clockify} from './clockify/clockify.ts';
import {Emoji} from './emoji/emoji.ts';
import {Launcher, type View} from './lib/launcher.ts';
import {Timers} from './lib/output.ts';
import {Recents} from './lib/recents.ts';
import {Passwords} from './passwords/passwords.ts';
import {Root} from './root.ts';
import {System} from './system/system.ts';
import {T3Code} from './t3code/t3code.ts';

export default class QuickLauncherExtension extends Extension {
    #timers: Timers | null = null;
    #launcher: Launcher | null = null;
    #rates: ExchangeRates | null = null;
    #passwords: Passwords | null = null;
    #clockify: Clockify | null = null;
    #t3code: T3Code | null = null;
    #shortcuts: string[] = [];

    override enable() {
        const settings = this.getSettings();
        const launcher = new Launcher();
        const recents = new Recents(settings);
        this.#timers = new Timers();
        this.#launcher = launcher;
        this.#rates = new ExchangeRates();
        this.#passwords = new Passwords(settings, this.#timers, this.dir.get_child('icons'), launcher, recents);
        this.#clockify = new Clockify(settings, launcher, recents);
        this.#t3code = new T3Code(settings, launcher, recents);
        const root = new Root({
            settings,
            launcher,
            recents,
            rates: this.#rates,
            passwords: this.#passwords,
            clockify: this.#clockify,
            emoji: new Emoji(this.dir.get_child('emoji').get_child('emoji.json'), launcher, recents),
            system: new System(launcher),
            t3code: this.#t3code,
            openPreferences: () => this.openPreferences(),
        });

        const toggle = (view: View) => () => {
            if (launcher.isOpen)
                launcher.close();
            else
                launcher.open(view);
        };
        this.#bind('shortcut', settings, toggle(root.view));
        this.#bind('clockify-shortcut', settings, () => {
            this.#clockify?.load();
            toggle(this.#clockify!.view)();
        });
    }

    #bind(key: string, settings: ReturnType<Extension['getSettings']>, handler: () => void) {
        Main.wm.addKeybinding(key, settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, handler);
        this.#shortcuts.push(key);
    }

    override disable() {
        for (const key of this.#shortcuts)
            Main.wm.removeKeybinding(key);
        this.#shortcuts = [];
        this.#launcher?.destroy();
        this.#passwords?.destroy();
        this.#clockify?.destroy();
        this.#t3code?.destroy();
        this.#rates?.destroy();
        this.#timers?.clear();
        this.#launcher = null;
        this.#passwords = null;
        this.#clockify = null;
        this.#t3code = null;
        this.#rates = null;
        this.#timers = null;
    }
}
