import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Bitwarden} from './bitwarden.js';
import {Clockify} from './clockify.js';
import {Timers} from './output.js';

export default class QuickLauncherExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._timers = new Timers();
        this._launchers = {
            'shortcut': new Bitwarden(this._settings, this._timers),
            'clockify-shortcut': new Clockify(this._settings),
        };

        for (const [key, launcher] of Object.entries(this._launchers)) {
            Main.wm.addKeybinding(key, this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => launcher.toggle());
        }
    }

    disable() {
        for (const [key, launcher] of Object.entries(this._launchers)) {
            Main.wm.removeKeybinding(key);
            launcher.destroy();
        }
        this._timers.clear();
        this._launchers = null;
        this._timers = null;
        this._settings = null;
    }
}
