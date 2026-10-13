import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {CURRENCIES} from './calc/units.ts';
import {findProgram} from './lib/subprocess.ts';
import {setPinentryBridge} from './passwords/bridge.ts';

export default class QuickLauncherPreferences extends ExtensionPreferences {
    override async fillPreferencesWindow(window: Adw.PreferencesWindow) {
        const settings = this.getSettings();
        window.set_default_size(640, 760);
        window.add(generalPage(settings));
        window.add(this.#passwordsPage(settings));
        window.add(clockifyPage(settings));
    }

    #passwordsPage(settings: Gio.Settings): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({title: 'Passwords', icon_name: 'dialog-password-symbolic'});

        const bitwarden = new Adw.PreferencesGroup({
            title: 'Bitwarden',
            description: 'Through rbw (https://github.com/doy/rbw); set it up with rbw config set email …',
        });
        bitwarden.add(switchRow(settings, 'bitwarden-enabled', 'Enabled'));
        bitwarden.add(programRow(settings, 'rbw-path', 'rbw binary'));
        bitwarden.add(this.#pinentryRow(settings));
        page.add(bitwarden);

        const onePassword = new Adw.PreferencesGroup({
            title: '1Password',
            description: 'Through the 1Password CLI (op)',
        });
        onePassword.add(switchRow(settings, 'onepassword-enabled', 'Enabled'));
        onePassword.add(programRow(settings, 'op-path', 'op binary'));

        const account = new Adw.EntryRow({title: 'Account (empty = default)', show_apply_button: true});
        settings.bind('onepassword-account', account, 'text', Gio.SettingsBindFlags.DEFAULT);
        onePassword.add(account);

        const methods = [
            ['auto', 'Automatic', 'Desktop app if installed, otherwise master password'],
            ['app', 'Desktop app', 'Needs “Integrate with 1Password CLI” in the app’s developer settings'],
            ['password', 'Master password', 'Typed into the launcher; the session lives in memory only'],
        ] as const;
        const unlock = new Adw.ComboRow({
            title: 'Unlock with',
            model: Gtk.StringList.new(methods.map(m => m[1])),
        });
        const syncUnlock = () => {
            const index = methods.findIndex(m => m[0] === settings.get_string('onepassword-unlock'));
            unlock.selected = Math.max(0, index);
            unlock.subtitle = methods[unlock.selected][2];
        };
        syncUnlock();
        unlock.connect('notify::selected', () => settings.set_string('onepassword-unlock', methods[unlock.selected][0]));
        const unlockId = settings.connect('changed::onepassword-unlock', syncUnlock);
        unlock.connect('destroy', () => settings.disconnect(unlockId));
        onePassword.add(unlock);
        page.add(onePassword);

        const output = new Adw.PreferencesGroup({title: 'Copy & type'});
        output.add(spinRow(settings, 'clear-clipboard-seconds', 'Clear clipboard after', 'Seconds, 0 = never', 3600, 5));
        output.add(switchRow(settings, 'scrub-clipboard-history', 'Remove secrets from Clipboard Indicator history'));
        output.add(spinRow(settings, 'type-delay-ms', 'Delay between typed keys', 'Milliseconds; raise this if characters get lost', 200, 1));
        output.add(switchRow(settings, 'submit-after-password', 'Press Enter after typing a password'));
        page.add(output);

        return page;
    }

    /** Answers rbw's password prompt in the launcher; see setPinentryBridge(). */
    #pinentryRow(settings: Gio.Settings): Adw.SwitchRow {
        const row = new Adw.SwitchRow({
            title: 'Enter master password in the launcher',
            subtitle: 'Sets rbw’s pinentry to a bridge script; turning this off restores the previous one',
            active: settings.get_boolean('rbw-pinentry-bridge'),
        });
        row.connect('notify::active', async () => {
            if (row.active === settings.get_boolean('rbw-pinentry-bridge'))
                return;
            try {
                await setPinentryBridge(settings, row.active, this.dir);
                row.remove_css_class('error');
            } catch (e) {
                console.error('quick-launcher: Could not configure rbw pinentry', e);
                row.subtitle = `Failed: ${(e as Error).message}`;
                row.add_css_class('error');
                row.active = settings.get_boolean('rbw-pinentry-bridge');
            }
        });
        // Getting Started in the launcher turns it on too.
        const id = settings.connect('changed::rbw-pinentry-bridge', () => {
            row.active = settings.get_boolean('rbw-pinentry-bridge');
        });
        row.connect('destroy', () => settings.disconnect(id));
        return row;
    }
}

function generalPage(settings: Gio.Settings): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({title: 'General', icon_name: 'system-search-symbolic'});

    const launcher = new Adw.PreferencesGroup({
        description: 'One launcher for passwords, Clockify, the calculator, emoji and system commands. Start typing to search everything at once.',
    });
    launcher.add(shortcutRow(settings, 'shortcut', 'Open launcher'));
    page.add(launcher);

    const calculator = new Adw.PreferencesGroup({
        title: 'Calculator',
        description: 'Exchange rates are the European Central Bank\'s daily reference rates, fetched at most twice a day',
    });
    const currency = new Adw.ComboRow({
        title: 'Default currency',
        subtitle: 'Amounts like “100 usd” are converted to it',
        model: Gtk.StringList.new(CURRENCIES),
        selected: Math.max(0, CURRENCIES.indexOf(settings.get_string('default-currency'))),
    });
    currency.connect('notify::selected', () => settings.set_string('default-currency', CURRENCIES[currency.selected]));
    calculator.add(currency);
    page.add(calculator);

    const t3 = new Adw.PreferencesGroup({
        title: 'T3 Code',
        description: Gio.AppInfo.get_default_for_uri_scheme('t3code') ?? Gio.AppInfo.get_all_for_type('x-scheme-handler/t3code')[0]
            ? 'Active sessions (not settled or archived) show up in the search, with whether they are working right now'
            : 'T3 Code doesn’t seem to be installed; sessions show up once it is',
    });
    t3.add(switchRow(settings, 't3code-enabled', 'Search T3 Code sessions'));
    const dataDir = new Adw.EntryRow({title: 'Data directory (empty = ~/.t3/userdata)', show_apply_button: true});
    settings.bind('t3code-data-dir', dataDir, 'text', Gio.SettingsBindFlags.DEFAULT);
    t3.add(dataDir);
    page.add(t3);

    const history = new Adw.PreferencesGroup();
    const clear = new Adw.ActionRow({title: 'Recently used items', subtitle: 'Shown when the launcher opens'});
    const button = new Gtk.Button({label: 'Clear', valign: Gtk.Align.CENTER});
    button.connect('clicked', () => settings.set_strv('recent', []));
    clear.add_suffix(button);
    history.add(clear);
    page.add(history);
    return page;
}

function clockifyPage(settings: Gio.Settings): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({title: 'Clockify', icon_name: 'alarm-symbolic'});

    const general = new Adw.PreferencesGroup({
        description: 'Start timers from your recent time entries, or a new one with @project and #tags',
    });
    general.add(shortcutRow(settings, 'clockify-shortcut', 'Open Clockify directly'));
    page.add(general);

    const api = new Adw.PreferencesGroup({
        title: 'API',
        description: 'Create a key under Clockify → Profile settings → API',
    });
    const key = new Adw.PasswordEntryRow({title: 'API key', show_apply_button: true});
    settings.bind('clockify-api-key', key, 'text', Gio.SettingsBindFlags.DEFAULT);
    api.add(key);

    const url = new Adw.EntryRow({title: 'API URL (regional: https://euc1.clockify.me/api/v1)', show_apply_button: true});
    settings.bind('clockify-api-url', url, 'text', Gio.SettingsBindFlags.DEFAULT);
    api.add(url);
    page.add(api);

    return page;
}

function switchRow(settings: Gio.Settings, key: string, title: string): Adw.SwitchRow {
    const row = new Adw.SwitchRow({title});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings: Gio.Settings, key: string, title: string, subtitle: string, upper: number, step: number): Adw.SpinRow {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower: 0, upper, step_increment: step}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** An entry for a binary that turns red if it can't be found. */
function programRow(settings: Gio.Settings, key: string, title: string): Adw.EntryRow {
    const row = new Adw.EntryRow({title, show_apply_button: true});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    const check = () => {
        if (findProgram(settings.get_string(key)))
            row.remove_css_class('error');
        else
            row.add_css_class('error');
    };
    check();
    const id = settings.connect(`changed::${key}`, check);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

/** Shows a keyboard shortcut; click to record a new one. */
function shortcutRow(settings: Gio.Settings, key: string, title: string): Adw.ActionRow {
    const label = new Gtk.ShortcutLabel({
        disabled_text: 'Disabled',
        valign: Gtk.Align.CENTER,
    });
    const row = new Adw.ActionRow({title, activatable: true});
    row.add_suffix(label);

    const sync = () => {
        label.accelerator = settings.get_strv(key)[0] ?? '';
    };
    sync();
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));

    row.connect('activated', () => {
        const dialog = new Adw.AlertDialog({
            heading: title,
            body: 'Press a shortcut, Esc to cancel or Backspace to disable it.',
        });
        dialog.add_response('cancel', 'Cancel');

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_controller, keyval: number, keycode: number, state: Gdk.ModifierType) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (!mods && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mods && keyval === Gdk.KEY_BackSpace) {
                settings.set_strv(key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!Gtk.accelerator_valid(keyval, mods))
                return Gdk.EVENT_STOP;

            settings.set_strv(key, [Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods)]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present(row);
    });
    return row;
}
