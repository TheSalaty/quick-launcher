import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class QuickLauncherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const general = new Adw.PreferencesGroup({title: 'Bitwarden'});
        page.add(general);

        general.add(shortcutRow(settings, 'shortcut', '<Shift><Control>Return'));

        const rbwPath = new Adw.EntryRow({title: 'rbw binary', show_apply_button: true});
        settings.bind('rbw-path', rbwPath, 'text', Gio.SettingsBindFlags.DEFAULT);
        general.add(rbwPath);

        const clipboard = new Adw.PreferencesGroup({title: 'Clipboard'});
        page.add(clipboard);

        const clear = new Adw.SpinRow({
            title: 'Clear clipboard after',
            subtitle: 'Seconds, 0 = never',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 3600, step_increment: 5}),
        });
        settings.bind('clear-clipboard-seconds', clear, 'value', Gio.SettingsBindFlags.DEFAULT);
        clipboard.add(clear);

        const scrub = new Adw.SwitchRow({
            title: 'Remove secrets from Clipboard Indicator history',
        });
        settings.bind('scrub-clipboard-history', scrub, 'active', Gio.SettingsBindFlags.DEFAULT);
        clipboard.add(scrub);

        const typing = new Adw.PreferencesGroup({title: 'Typing'});
        page.add(typing);

        const delay = new Adw.SpinRow({
            title: 'Delay between keys',
            subtitle: 'Milliseconds; raise this if characters get lost',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 200, step_increment: 1}),
        });
        settings.bind('type-delay-ms', delay, 'value', Gio.SettingsBindFlags.DEFAULT);
        typing.add(delay);

        const submit = new Adw.SwitchRow({
            title: 'Press Enter after typing a password',
        });
        settings.bind('submit-after-password', submit, 'active', Gio.SettingsBindFlags.DEFAULT);
        typing.add(submit);

        const clockify = new Adw.PreferencesGroup({
            title: 'Clockify',
            description: 'API key from Clockify → Profile settings → API',
        });
        page.add(clockify);

        clockify.add(shortcutRow(settings, 'clockify-shortcut', '<Shift><Alt>Return'));

        const apiKey = new Adw.PasswordEntryRow({title: 'API key', show_apply_button: true});
        settings.bind('clockify-api-key', apiKey, 'text', Gio.SettingsBindFlags.DEFAULT);
        clockify.add(apiKey);

        const apiUrl = new Adw.EntryRow({
            title: 'API URL (regional: https://euc1.clockify.me/api/v1)',
            show_apply_button: true,
        });
        settings.bind('clockify-api-url', apiUrl, 'text', Gio.SettingsBindFlags.DEFAULT);
        clockify.add(apiUrl);
    }
}

function shortcutRow(settings, key, example) {
    const row = new Adw.EntryRow({
        title: `Shortcut (e.g. ${example})`,
        text: settings.get_strv(key)[0] ?? '',
        show_apply_button: true,
    });
    row.connect('apply', () => {
        const accel = row.text.trim();
        const [ok] = Gtk.accelerator_parse(accel);
        if (ok || accel === '') {
            settings.set_strv(key, accel ? [accel] : []);
            row.remove_css_class('error');
        } else {
            row.add_css_class('error');
        }
    });
    return row;
}
