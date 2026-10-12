import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

const MAX_ROWS = 50;
const WIDTH = 680;

export interface Keys {
    /** Enter or a click */
    enter: boolean;
    /** Lowercase character of the pressed key, '' for Enter */
    char: string;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
}

export interface RowContent {
    icon: string;
    iconStyle?: string | null;
    title: string;
    subtitle?: string;
    /** Small pill on the right, e.g. the vault an item comes from */
    badge?: {text: string; styleClass?: string; style?: string};
    /** Dim text on the right, e.g. a time */
    trailing?: string;
    dim?: boolean;
}

export interface LauncherOptions<T extends {id: string}> {
    icon: string;
    placeholder: string;
    hints: string;
    search(query: string): T[];
    describe(item: T): RowContent;
    /** Maps a key press (or click) on an item to an action name, or null. */
    actionFor(item: T, keys: Keys): string | null;
    /** Ctrl+<char> shortcuts that don't need a selected item */
    commands?: Record<string, () => void>;
    /** The launcher stays open; call close() when appropriate. */
    onActivate(item: T, action: string): void;
}

interface SecretRequest {
    resolve(secret: string | null): void;
    /** The launcher was opened just for this prompt and closes afterwards. */
    standalone: boolean;
    savedQuery: string;
}

interface Row {
    actor: St.BoxLayout;
    icon: St.Icon;
    title: St.Label;
    subtitle: St.Label;
    badge: St.Label;
    trailing: St.Label;
    /** Inline icon style (e.g. a project color), dropped while selected */
    iconStyle: string | null;
}

/** A Spotlight-style search popup; providers supply items and actions. */
export class Launcher<T extends {id: string}> {
    readonly #options: LauncherOptions<T>;
    readonly #backdrop: St.Widget;
    readonly #box: St.BoxLayout;
    readonly #entry: St.Entry;
    readonly #entryIcon: St.Icon;
    readonly #status: St.Label;
    readonly #scroll: St.ScrollView;
    readonly #list: St.BoxLayout;
    readonly #hints: St.Label;
    readonly #rows: Row[] = [];
    #results: T[] = [];
    #visibleRows = 0;
    #selected = 0;
    #grab: Clutter.Grab | null = null;
    #secret: SecretRequest | null = null;

    constructor(options: LauncherOptions<T>) {
        this.#options = options;

        this.#backdrop = new St.Widget({
            reactive: true,
            visible: false,
            constraints: new Clutter.BindConstraint({
                source: global.stage,
                coordinate: Clutter.BindCoordinate.ALL,
            }),
        });
        this.#backdrop.connect('button-press-event', (_actor, event: Clutter.Event) => {
            const [x, y] = event.get_coords();
            const [bx, by] = this.#box.get_transformed_position();
            const [bw, bh] = this.#box.get_transformed_size();
            if (x < bx || x > bx + bw || y < by || y > by + bh)
                this.close();
            return Clutter.EVENT_PROPAGATE;
        });

        this.#box = new St.BoxLayout({
            style_class: 'ql-box',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this.#backdrop.add_child(this.#box);

        this.#entryIcon = new St.Icon({icon_name: options.icon, style_class: 'ql-entry-icon'});
        this.#entry = new St.Entry({
            style_class: 'ql-entry',
            hint_text: options.placeholder,
            can_focus: true,
            x_expand: true,
            primary_icon: this.#entryIcon,
        });
        this.#box.add_child(this.#entry);

        const text = this.#entry.clutter_text;
        text.connect('text-changed', () => {
            if (!this.#secret)
                this.#update();
        });
        text.connect('key-press-event', (_actor, event: Clutter.Event) => this.#onKeyPress(event));

        this.#status = new St.Label({style_class: 'ql-status', visible: false});
        this.#status.clutter_text.line_wrap = true;
        this.#box.add_child(this.#status);

        this.#list = new St.BoxLayout({
            style_class: 'ql-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this.#scroll = new St.ScrollView({
            style_class: 'ql-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this.#list,
        });
        this.#box.add_child(this.#scroll);

        this.#hints = new St.Label({style_class: 'ql-hints', text: options.hints});
        this.#hints.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.#box.add_child(this.#hints);

        Main.layoutManager.uiGroup.add_child(this.#backdrop);
    }

    get isOpen(): boolean {
        return this.#grab !== null;
    }

    get query(): string {
        return this.#secret ? this.#secret.savedQuery : this.#entry.get_text();
    }

    get selected(): T | null {
        return this.#results[this.#selected] ?? null;
    }

    open({query = '', selectId = ''}: {query?: string; selectId?: string} = {}) {
        if (this.isOpen)
            return;

        const monitor = Main.layoutManager.currentMonitor;
        if (!monitor)
            return;
        if (!monitor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = Math.min(WIDTH * scale, monitor.width * 0.9);
        this.#box.set_position(
            Math.round(monitor.x + (monitor.width - width) / 2),
            Math.round(monitor.y + monitor.height * 0.18));
        this.#box.width = width;

        this.#backdrop.show();
        Main.layoutManager.uiGroup.set_child_above_sibling(this.#backdrop, null);
        this.#grab = Main.pushModal(this.#backdrop, {actionMode: Shell.ActionMode.SYSTEM_MODAL});

        this.#entry.set_text(query);
        this.#update(selectId);
        this.#entry.grab_key_focus();
        this.#entry.clutter_text.set_selection(0, query.length);

        this.#box.opacity = 0;
        this.#box.ease({opacity: 255, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    close() {
        const grab = this.#grab;
        if (!grab)
            return;
        this.#grab = null;
        this.#resolveSecret(null);
        Main.popModal(grab);
        this.#box.remove_all_transitions();
        this.#backdrop.hide();
    }

    /** Re-runs the search, e.g. after the data changed. Keeps the selected item. */
    refresh() {
        if (this.isOpen && !this.#secret)
            this.#update(this.selected?.id);
    }

    setStatus(text: string | null) {
        this.#status.text = text ?? '';
        this.#status.visible = !!text;
    }

    /**
     * Turns the search field into a password field until the user presses
     * Enter (resolves the text) or Esc (resolves null).
     */
    askSecret({prompt, description}: {prompt: string; description?: string}): Promise<string | null> {
        this.#resolveSecret(null);

        const standalone = !this.isOpen;
        if (standalone)
            this.open();

        const savedQuery = this.#entry.get_text();
        const promise = new Promise<string | null>(resolve => {
            this.#secret = {resolve, standalone, savedQuery};
        });

        this.#box.add_style_pseudo_class('secret');
        this.#entryIcon.icon_name = 'system-lock-screen-symbolic';
        this.#entry.hint_text = prompt;
        this.#entry.clutter_text.password_char = 0x2022; // •
        this.#entry.set_text('');
        this.#entry.grab_key_focus();
        this.#scroll.hide();
        this.#hints.text = '⏎ unlock   Esc cancel';
        this.setStatus(description ?? null);
        return promise;
    }

    #resolveSecret(value: string | null) {
        const request = this.#secret;
        if (!request)
            return;
        this.#secret = null;

        this.#box.remove_style_pseudo_class('secret');
        this.#entryIcon.icon_name = this.#options.icon;
        this.#entry.hint_text = this.#options.placeholder;
        this.#entry.clutter_text.password_char = 0;
        this.#entry.set_text(request.savedQuery);
        this.#hints.text = this.#options.hints;
        this.setStatus(null);
        this.#scroll.show();

        if (request.standalone)
            this.close();

        request.resolve(value);
    }

    #update(selectId?: string) {
        this.#results = this.#options.search(this.#entry.get_text());
        this.#visibleRows = Math.min(this.#results.length, MAX_ROWS);

        for (let i = 0; i < this.#visibleRows; i++)
            this.#fillRow(this.#row(i), this.#options.describe(this.#results[i]));
        for (let i = this.#visibleRows; i < this.#rows.length; i++)
            this.#rows[i].actor.hide();
        this.#scroll.visible = this.#visibleRows > 0;

        const index = selectId ? this.#results.findIndex(r => r.id === selectId) : -1;
        this.#select(Math.max(0, index));
    }

    /** Rows are created once and reused, so typing doesn't rebuild actors. */
    #row(index: number): Row {
        let row = this.#rows[index];
        if (row)
            return row;

        const actor = new St.BoxLayout({style_class: 'ql-row', reactive: true, track_hover: true});
        const icon = new St.Icon({style_class: 'ql-row-icon', y_align: Clutter.ActorAlign.CENTER});
        const labels = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const title = new St.Label({style_class: 'ql-row-title'});
        const subtitle = new St.Label({style_class: 'ql-row-subtitle'});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        labels.add_child(title);
        labels.add_child(subtitle);

        const trailing = new St.Label({style_class: 'ql-row-trailing', y_align: Clutter.ActorAlign.CENTER});
        const badge = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        for (const child of [icon, labels, trailing, badge])
            actor.add_child(child);

        actor.connect('button-release-event', (_actor, event: Clutter.Event) => {
            this.#select(index);
            this.#activate({enter: true, char: '', ...modifiers(event)});
            return Clutter.EVENT_STOP;
        });

        row = {actor, icon, title, subtitle, badge, trailing, iconStyle: null};
        this.#rows.push(row);
        this.#list.add_child(actor);
        return row;
    }

    #fillRow(row: Row, content: RowContent) {
        row.icon.icon_name = content.icon;
        row.iconStyle = content.iconStyle ?? null;
        row.icon.style = row.actor.has_style_pseudo_class('selected') ? null : row.iconStyle;
        row.title.text = content.title;
        row.subtitle.text = content.subtitle ?? '';
        row.subtitle.visible = !!content.subtitle;
        row.trailing.text = content.trailing ?? '';
        row.trailing.visible = !!content.trailing;
        row.badge.text = content.badge?.text ?? '';
        row.badge.style_class = `ql-badge ${content.badge?.styleClass ?? ''}`;
        row.badge.style = content.badge?.style ?? null;
        row.badge.visible = !!content.badge;
        if (content.dim)
            row.actor.add_style_class_name('ql-row-dim');
        else
            row.actor.remove_style_class_name('ql-row-dim');
        row.actor.show();
    }

    #select(index: number) {
        const previous = this.#rows[this.#selected];
        if (previous) {
            previous.actor.remove_style_pseudo_class('selected');
            previous.icon.style = previous.iconStyle;
        }
        if (this.#visibleRows === 0) {
            this.#selected = 0;
            return;
        }
        this.#selected = Math.max(0, Math.min(index, this.#visibleRows - 1));
        const row = this.#rows[this.#selected];
        row.actor.add_style_pseudo_class('selected');
        row.icon.style = null;
        ensureActorVisibleInScrollView(this.#scroll, row.actor);
    }

    #activate(keys: Keys): boolean {
        const item = this.selected;
        const action = item && this.#options.actionFor(item, keys);
        if (!item || !action)
            return false;
        this.#options.onActivate(item, action);
        return true;
    }

    #onKeyPress(event: Clutter.Event): boolean {
        const symbol = event.get_key_symbol();
        const mods = modifiers(event);
        const isEnter = symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter ||
            symbol === Clutter.KEY_ISO_Enter;

        if (this.#secret) {
            if (symbol === Clutter.KEY_Escape) {
                this.#resolveSecret(null);
                return Clutter.EVENT_STOP;
            }
            if (isEnter) {
                this.#resolveSecret(this.#entry.get_text());
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (isEnter) {
            this.#activate({enter: true, char: '', ...mods});
            return Clutter.EVENT_STOP;
        }

        const moves: Partial<Record<number, number>> = {
            [Clutter.KEY_Up]: -1,
            [Clutter.KEY_KP_Up]: -1,
            [Clutter.KEY_ISO_Left_Tab]: -1,
            [Clutter.KEY_Down]: 1,
            [Clutter.KEY_KP_Down]: 1,
            [Clutter.KEY_Tab]: 1,
            [Clutter.KEY_Page_Up]: -8,
            [Clutter.KEY_Page_Down]: 8,
        };
        const move = moves[symbol];
        if (move !== undefined) {
            this.#select(this.#selected + move);
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        const char = String.fromCodePoint(Clutter.keysym_to_unicode(symbol) || 0).toLowerCase();
        if (mods.ctrl && !mods.alt) {
            const ctrlMoves: Record<string, number> = {p: -1, k: -1, n: 1, j: 1};
            if (char in ctrlMoves) {
                this.#select(this.#selected + ctrlMoves[char]);
                return Clutter.EVENT_STOP;
            }
            const command = this.#options.commands?.[char];
            if (command) {
                command();
                return Clutter.EVENT_STOP;
            }
        }

        if ((mods.ctrl || mods.alt) && this.#activate({enter: false, char, ...mods}))
            return Clutter.EVENT_STOP;
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        this.close();
        this.#backdrop.destroy();
    }
}

function modifiers(event: Clutter.Event) {
    const state = event.get_state();
    return {
        ctrl: (state & Clutter.ModifierType.CONTROL_MASK) !== 0,
        shift: (state & Clutter.ModifierType.SHIFT_MASK) !== 0,
        alt: (state & Clutter.ModifierType.MOD1_MASK) !== 0,
    };
}
