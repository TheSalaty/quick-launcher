import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CLIPBOARD_INDICATOR_UUID = 'clipboard-indicator@tudmotu.com';
const HELD_MODIFIERS = Clutter.ModifierType.SHIFT_MASK |
    Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.MOD4_MASK |
    Clutter.ModifierType.SUPER_MASK;

/** Timeouts that are cancelled together when the extension is disabled. */
export class Timers {
    constructor() {
        this._ids = new Set();
    }

    add(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._ids.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._ids.add(id);
        return id;
    }

    remove(id) {
        if (this._ids.delete(id))
            GLib.source_remove(id);
    }

    sleep(ms) {
        return new Promise(resolve => this.add(ms, resolve));
    }

    clear() {
        for (const id of this._ids)
            GLib.source_remove(id);
        this._ids.clear();
    }
}

export class SecretClipboard {
    constructor(settings, timers) {
        this._settings = settings;
        this._timers = timers;
        this._clipboard = St.Clipboard.get_default();
        this._secret = null;
        this._clearId = 0;
    }

    copy(secret) {
        this._timers.remove(this._clearId);
        this._clearId = 0;

        this._secret = secret;
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, secret);

        // Clipboard Indicator records the selection asynchronously.
        this._timers.add(300, () => this._scrubHistory(secret));
        this._timers.add(1500, () => this._scrubHistory(secret));

        const seconds = this._settings.get_int('clear-clipboard-seconds');
        if (seconds > 0)
            this._clearId = this._timers.add(seconds * 1000, () => this.clear());
    }

    /** Clears the clipboard, but only if it still holds our secret. */
    clear() {
        const secret = this._secret;
        this._secret = null;
        if (secret === null)
            return;

        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            if (text === secret)
                this._clipboard.set_text(St.ClipboardType.CLIPBOARD, '');
        });
        this._scrubHistory(secret);
    }

    /** Clears synchronously; used on disable when callbacks may not run. */
    clearNow() {
        if (this._secret !== null)
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, '');
        this._secret = null;
    }

    _scrubHistory(secret) {
        if (!this._settings.get_boolean('scrub-clipboard-history'))
            return;

        const indicator = Main.extensionManager
            .lookup(CLIPBOARD_INDICATOR_UUID)?.stateObj?.clipboardIndicator;
        const items = indicator?.clipItemsRadioGroup;
        if (!Array.isArray(items) || typeof indicator._removeEntry !== 'function')
            return;

        for (const item of [...items]) {
            if (item.entry?.getStringValue?.() === secret)
                indicator._removeEntry(item);
        }
    }
}

export class Typist {
    constructor(settings, timers) {
        this._settings = settings;
        this._timers = timers;
        this._device = null;
    }

    async type(text) {
        await this._waitForModifierRelease();

        this._device ??= global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        const delay = this._settings.get_int('type-delay-ms');
        for (const char of text) {
            const keyval = char === '\t' ? Clutter.KEY_Tab
                : char === '\n' ? Clutter.KEY_Return
                    : Clutter.unicode_to_keysym(char.codePointAt(0));

            const time = GLib.get_monotonic_time();
            this._device.notify_keyval(time, keyval, Clutter.KeyState.PRESSED);
            this._device.notify_keyval(time, keyval, Clutter.KeyState.RELEASED);
            if (delay > 0)
                await this._timers.sleep(delay);
        }
    }

    // The launcher is triggered by e.g. Ctrl+Enter; typing while Ctrl is
    // still held would send shortcuts instead of text. Also give the
    // previously focused window a moment to get focus back.
    async _waitForModifierRelease() {
        await this._timers.sleep(80);
        for (let i = 0; i < 150; i++) {
            const [, , mods] = global.get_pointer();
            if ((mods & HELD_MODIFIERS) === 0)
                break;
            await this._timers.sleep(20);
        }
        await this._timers.sleep(40);
    }

    destroy() {
        this._device = null;
    }
}
