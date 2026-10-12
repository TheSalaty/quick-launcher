import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

const MAX_ROWS = 50;

/**
 * The popup, configured by a provider:
 * - icon, placeholder, hints: search field icon, hint text and key help
 * - search(entries, query): entries to show, best first
 * - describe(entry): {icon, title, subtitle, iconStyle} for a row
 * - actionFor({enter, char, ctrl, shift, alt}): action name for a key
 *   press (enter is true for Enter and clicks), or null
 * - commands: {char: callback} run on Ctrl+char without an entry
 * - onActivate(entry, action): called after the popup closed
 */
export class Launcher {
    constructor({icon, placeholder, hints, search, describe, actionFor, commands = {}, onActivate}) {
        this._search = search;
        this._describe = describe;
        this._actionFor = actionFor;
        this._commands = commands;
        this._onActivate = onActivate;
        this._entries = [];
        this._results = [];
        this._rows = [];
        this._selected = 0;
        this._grab = null;

        this._backdrop = new St.Widget({
            reactive: true,
            visible: false,
            constraints: new Clutter.BindConstraint({
                source: global.stage,
                coordinate: Clutter.BindCoordinate.ALL,
            }),
        });
        this._backdrop.connect('button-press-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            const [bx, by] = this._box.get_transformed_position();
            const [bw, bh] = this._box.get_transformed_size();
            if (x < bx || x > bx + bw || y < by || y > by + bh)
                this.close();
            return Clutter.EVENT_PROPAGATE;
        });

        this._box = new St.BoxLayout({
            style_class: 'bwl-box',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._backdrop.add_child(this._box);

        this._entry = new St.Entry({
            style_class: 'bwl-entry',
            hint_text: placeholder,
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({
                icon_name: icon,
                style_class: 'bwl-entry-icon',
            }),
        });
        this._box.add_child(this._entry);

        const text = this._entry.clutter_text;
        text.connect('text-changed', () => this._update());
        text.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

        this._status = new St.Label({style_class: 'bwl-status', visible: false});
        this._box.add_child(this._status);

        this._list = new St.BoxLayout({
            style_class: 'bwl-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scroll = new St.ScrollView({
            style_class: 'bwl-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._list,
        });
        this._box.add_child(this._scroll);

        this._box.add_child(new St.Label({style_class: 'bwl-hints', text: hints}));

        Main.layoutManager.uiGroup.add_child(this._backdrop);
    }

    get isOpen() {
        return this._grab !== null;
    }

    open({query = '', selectedId = ''} = {}) {
        if (this.isOpen)
            return;

        const monitor = Main.layoutManager.currentMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = Math.min(680 * scale, monitor.width * 0.9);
        this._box.set_position(
            Math.round(monitor.x + (monitor.width - width) / 2),
            Math.round(monitor.y + monitor.height * 0.18));
        this._box.width = width;

        this._backdrop.show();
        Main.layoutManager.uiGroup.set_child_above_sibling(this._backdrop, null);

        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.SYSTEM_MODAL});

        this._pendingSelectedId = selectedId;
        this._entry.set_text(query);
        this._update();
        this._entry.grab_key_focus();
        this._entry.clutter_text.set_selection(0, query.length);
    }

    close() {
        if (!this.isOpen)
            return;
        Main.popModal(this._grab);
        this._grab = null;
        this._backdrop.hide();
    }

    get query() {
        return this._entry.get_text();
    }

    setEntries(entries) {
        this._entries = entries;
        if (this.isOpen) {
            this._pendingSelectedId ||= this._results[this._selected]?.id ?? '';
            this._update();
        }
    }

    setStatus(text) {
        this._status.text = text ?? '';
        this._status.visible = !!text;
    }

    _update() {
        this._results = this._search(this._entries, this.query);

        this._list.destroy_all_children();
        this._rows = this._results.slice(0, MAX_ROWS).map((entry, i) => {
            const row = this._createRow(entry, i);
            this._list.add_child(row);
            return row;
        });
        this._scroll.visible = this._rows.length > 0;

        let selected = 0;
        if (this._pendingSelectedId) {
            selected = Math.max(0, this._rows.findIndex((_, i) =>
                this._results[i].id === this._pendingSelectedId));
            this._pendingSelectedId = '';
        }
        this._select(selected);
    }

    _createRow(entry, index) {
        const row = new St.BoxLayout({
            style_class: 'bwl-row',
            reactive: true,
            track_hover: true,
        });
        const {icon, title, subtitle, iconStyle} = this._describe(entry);
        row.add_child(new St.Icon({
            style_class: 'bwl-row-icon',
            style: iconStyle ?? null,
            icon_name: icon,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const labels = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const name = new St.Label({style_class: 'bwl-row-name', text: title});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        labels.add_child(name);

        if (subtitle) {
            const sub = new St.Label({style_class: 'bwl-row-subtitle', text: subtitle});
            sub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            labels.add_child(sub);
        }
        row.add_child(labels);

        row.connect('button-release-event', (_actor, event) => {
            this._select(index);
            this._activate(this._actionFor({enter: true, ...modifiers(event)}));
            return Clutter.EVENT_STOP;
        });
        return row;
    }

    _select(index) {
        if (this._rows.length === 0) {
            this._selected = 0;
            return;
        }
        this._rows[this._selected]?.remove_style_pseudo_class('selected');
        this._selected = Math.max(0, Math.min(index, this._rows.length - 1));
        const row = this._rows[this._selected];
        row.add_style_pseudo_class('selected');
        ensureActorVisibleInScrollView(this._scroll, row);
    }

    _activate(action) {
        const entry = this._results[this._selected];
        if (!action || !entry || !this._rows.length)
            return;
        this.close();
        this._onActivate(entry, action);
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const mods = modifiers(event);

        switch (symbol) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._activate(this._actionFor({enter: true, ...mods}));
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
        case Clutter.KEY_Tab:
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_ISO_Left_Tab:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
            this._select(this._selected - 8);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._select(this._selected + 8);
            return Clutter.EVENT_STOP;
        }

        const char = String.fromCodePoint(Clutter.keysym_to_unicode(symbol) || 0).toLowerCase();

        if (mods.ctrl && !mods.alt) {
            const moves = {p: -1, k: -1, n: 1, j: 1};
            if (char in moves) {
                this._select(this._selected + moves[char]);
                return Clutter.EVENT_STOP;
            }
            if (char in this._commands) {
                this._commands[char]();
                return Clutter.EVENT_STOP;
            }
        }

        const action = this._actionFor({enter: false, char, ...mods});
        if (action) {
            this._activate(action);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        this.close();
        this._backdrop.destroy();
    }
}

function modifiers(event) {
    const mods = event.get_state();
    return {
        ctrl: (mods & Clutter.ModifierType.CONTROL_MASK) !== 0,
        shift: (mods & Clutter.ModifierType.SHIFT_MASK) !== 0,
        alt: (mods & Clutter.ModifierType.MOD1_MASK) !== 0,
    };
}
