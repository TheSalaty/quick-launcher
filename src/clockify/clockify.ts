import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Launcher, type RowContent} from '../lib/launcher.ts';
import {notifyError, osd} from '../lib/output.ts';
import {SearchIndex, type Field} from '../lib/search.ts';
import {ClockifyApi} from './api.ts';
import {distinctTasks, duration, parseDraft, timeAgo, type Project, type Tag, type Task} from './tasks.ts';

Gio._promisify(Gio.File.prototype, 'replace_contents_async');

const HINTS = '⏎ start / stop   ⇧⏎ new from text   @project #tag   ⌃S stop   ⌃R reload';

interface CacheData {
    account: string;
    tasks: Task[];
    projects: Project[];
    tags: Tag[];
}

function searchFields(task: Task): Field[] {
    return [
        [10, task.description],
        [5, task.projectName],
        [5, task.taskName],
        [3, task.tagNames],
        [2, task.clientName],
    ];
}

function describe(task: Task): RowContent {
    const project = [task.projectName, task.taskName].filter(Boolean).join(': ');
    const tags = task.tagNames.map(t => `#${t}`).join(' ');
    const title = task.description || '(no description)';

    if (task.isNew) {
        return {
            icon: 'list-add-symbolic',
            title,
            subtitle: ['New entry', project, tags].filter(Boolean).join('  ·  '),
        };
    }
    return {
        icon: task.running ? 'media-playback-stop-symbolic' : 'media-playback-start-symbolic',
        iconStyle: task.color ? `color: ${task.color};` : null,
        title,
        subtitle: [project, task.clientName, tags].filter(Boolean).join('  ·  '),
        trailing: task.running ? `● ${duration(task.lastStart)}` : timeAgo(task.lastStart),
    };
}

/**
 * The last fetched tasks, projects and tags on disk, so the launcher has
 * something to show right away, even after a restart.
 */
class Cache {
    readonly #file = Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_cache_dir(), 'quick-launcher', 'clockify.json']));

    load(account: string): CacheData | null {
        try {
            const [, bytes] = this.#file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes)) as CacheData;
            return data.account === account ? data : null;
        } catch {
            return null;
        }
    }

    async save(data: CacheData) {
        try {
            this.#file.get_parent()!.make_directory_with_parents(null);
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)))
                throw e;
        }
        await this.#file.replace_contents_async(new TextEncoder().encode(JSON.stringify(data)),
            null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
}

/** Starts Clockify timers from recent entries or a new description. */
export class Clockify {
    readonly #settings: Gio.Settings;
    readonly #api: ClockifyApi;
    readonly #cache = new Cache();
    readonly #launcher: Launcher<Task>;
    #index = new SearchIndex<Task>([], searchFields);
    #projects: Project[] = [];
    #tags: Tag[] = [];
    #account: string | null = null;
    #destroyed = false;

    constructor(settings: Gio.Settings) {
        this.#settings = settings;
        this.#api = new ClockifyApi(settings);
        this.#launcher = new Launcher<Task>({
            icon: 'alarm-symbolic',
            placeholder: 'Start time entry…',
            hints: HINTS,
            search: query => this.#search(query),
            describe,
            actionFor: (_task, {enter, shift}) => enter ? shift ? 'new' : 'start' : null,
            commands: {
                r: () => void this.#reload(),
                s: () => void this.#stop(),
            },
            onActivate: (task, action) => void this.#start(task, action),
        });
    }

    destroy() {
        this.#destroyed = true;
        this.#launcher.destroy();
        this.#api.destroy();
    }

    toggle() {
        if (this.#launcher.isOpen) {
            this.#launcher.close();
            return;
        }
        this.#loadCache();
        this.#launcher.open({
            query: this.#settings.get_string('clockify-last-query'),
            selectId: this.#settings.get_string('clockify-last-entry-id'),
        });
        this.#launcher.setStatus(this.#index.items.length ? null : 'Loading…');
        void this.#reload();
    }

    /** Fills in the last fetched data, unless it belongs to another account. */
    #loadCache() {
        const account = this.#api.account;
        if (this.#account === account)
            return;

        this.#account = account;
        const {tasks = [], projects = [], tags = []} = this.#cache.load(account) ?? {};
        this.#setData(tasks, projects, tags);
    }

    #setData(tasks: Task[], projects: Project[], tags: Tag[]) {
        this.#projects = projects;
        this.#tags = tags;
        this.#index = new SearchIndex(tasks, searchFields);
        this.#launcher.refresh();
    }

    #search(query: string): Task[] {
        const results = this.#index.search(query.replace(/(^|\s)[@#]/g, '$1'));
        const draft = this.#draft(query);
        if (draft.description || draft.projectId)
            results.push(draft);
        return results;
    }

    #draft(query: string): Task {
        const {description, project, tags} = parseDraft(query, this.#projects, this.#tags);
        return {
            id: 'new',
            isNew: true,
            description,
            projectId: project?.id,
            billable: project?.billable ?? false,
            tagIds: tags.map(t => t.id),
            projectName: project?.name ?? '',
            clientName: project?.clientName ?? '',
            color: project?.color ?? null,
            taskName: '',
            tagNames: tags.map(t => t.name),
        };
    }

    async #reload() {
        if (!this.#api.configured) {
            this.#launcher.setStatus('Set your Clockify API key in the extension preferences');
            return;
        }
        try {
            const account = this.#api.account;
            const [entries, allProjects, allTags] = await Promise.all([
                this.#api.recent(), this.#api.projects(), this.#api.tags(),
            ]);
            if (this.#destroyed)
                return;

            // Only what parseDraft() and distinctTasks() need, to keep the cache small.
            const projects = allProjects.map(({id, name, billable, clientName, color}) =>
                ({id, name, billable, clientName, color}));
            const tags = allTags.map(({id, name}) => ({id, name}));
            const tasks = distinctTasks(entries, projects, tags);

            this.#account = account;
            this.#setData(tasks, projects, tags);
            this.#launcher.setStatus(null);

            this.#cache.save({account, tasks, projects, tags}).catch(e =>
                console.error('quick-launcher: Could not write Clockify cache', e));
        } catch (e) {
            if (this.#destroyed)
                return;
            console.error('quick-launcher: Clockify request failed', e);
            this.#launcher.setStatus(`Clockify: ${(e as Error).message}`);
        }
    }

    async #start(task: Task, action: string) {
        const query = this.#launcher.query;
        this.#settings.set_string('clockify-last-query', query);
        this.#settings.set_string('clockify-last-entry-id', task.id);

        if (task.running && action === 'start') {
            await this.#stop();
            return;
        }
        if (action === 'new' || task.isNew)
            task = this.#draft(query);
        if (!task.description && !task.projectId)
            return;

        this.#launcher.close();
        try {
            await this.#api.start(task);
            osd('media-playback-start-symbolic', task.description || task.projectName || 'Timer started');
            void this.#reload();
        } catch (e) {
            notifyError('Could not start Clockify timer', e);
        }
    }

    async #stop() {
        this.#launcher.close();
        try {
            if (await this.#api.stop())
                osd('media-playback-stop-symbolic', 'Timer stopped');
            else
                Main.notify('Clockify', 'No timer running');
            void this.#reload();
        } catch (e) {
            notifyError('Could not stop Clockify timer', e);
        }
    }
}
