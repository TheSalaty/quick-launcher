import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Launcher} from './launcher.js';
import {normalize, prepare, search} from './search.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');

const HINTS = '⏎ start   ⇧⏎ start new from text   @project #tag   ⌃S stop timer   ⌃R reload';

export class ClockifyError extends Error {}

class ClockifyApi {
    constructor(settings) {
        this._settings = settings;
        this._session = new Soup.Session({timeout: 20});
        this._user = null;
        this._userFor = '';
    }

    get configured() {
        return this._settings.get_string('clockify-api-key') !== '';
    }

    /** Identifies the account, so a cache never shows another account's data. */
    get account() {
        return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256,
            `${this._settings.get_string('clockify-api-url')}|${this._settings.get_string('clockify-api-key')}`, -1);
    }

    async _request(method, path, {query = {}, body} = {}) {
        const base = this._settings.get_string('clockify-api-url').replace(/\/+$/, '');
        const params = Object.entries(query)
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        const message = Soup.Message.new(method, `${base}${path}${params ? `?${params}` : ''}`);
        if (!message)
            throw new ClockifyError(`Invalid API URL: ${base}`);

        message.request_headers.append('X-Api-Key', this._settings.get_string('clockify-api-key'));
        if (body !== undefined) {
            message.set_request_body_from_bytes('application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        }

        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        const text = new TextDecoder().decode(bytes.toArray());
        const status = message.get_status();
        if (status < 200 || status >= 300) {
            let detail = text;
            try {
                detail = JSON.parse(text).message ?? text;
            } catch {}
            throw new ClockifyError(`${status} ${detail || message.get_reason_phrase()}`.trim());
        }
        return text ? JSON.parse(text) : null;
    }

    _me() {
        const key = `${this._settings.get_string('clockify-api-url')}|${this._settings.get_string('clockify-api-key')}`;
        if (this._userFor !== key) {
            this._userFor = key;
            this._user = this._request('GET', '/user').then(user =>
                ({id: user.id, workspace: user.activeWorkspace || user.defaultWorkspace}));
            this._user.catch(() => {
                if (this._userFor === key)
                    this._userFor = '';
            });
        }
        return this._user;
    }

    async _entriesPath() {
        const {id, workspace} = await this._me();
        return `/workspaces/${workspace}/user/${id}/time-entries`;
    }

    async recent() {
        return this._request('GET', await this._entriesPath(),
            {query: {'hydrated': true, 'page-size': 200}});
    }

    async projects() {
        const {workspace} = await this._me();
        return this._request('GET', `/workspaces/${workspace}/projects`,
            {query: {'archived': false, 'page-size': 500}});
    }

    async tags() {
        const {workspace} = await this._me();
        return this._request('GET', `/workspaces/${workspace}/tags`,
            {query: {'archived': false, 'page-size': 500}});
    }

    /** Stops the running timer at `end`. Resolves false if none was running. */
    async stop(end = now()) {
        const path = await this._entriesPath();
        const running = await this._request('GET', path, {query: {'in-progress': true}});
        if (!running?.length)
            return false;
        await this._request('PATCH', path, {body: {end}});
        return true;
    }

    /** Starts a timer, stopping the running one at the same instant. */
    async start({description, projectId, taskId, tagIds, billable}) {
        const {workspace} = await this._me();
        const start = now();
        await this.stop(start);
        return this._request('POST', `/workspaces/${workspace}/time-entries`, {
            body: {start, description, projectId, taskId, tagIds, billable},
        });
    }

    destroy() {
        this._session.abort();
    }
}

function now() {
    return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function findByName(items, token) {
    const wanted = normalize(token);
    const names = items.map(item => [item, normalize(item.name).replace(/\s+/g, '')]);
    return (names.find(([, n]) => n === wanted) ??
        names.find(([, n]) => n.startsWith(wanted)) ??
        names.find(([, n]) => n.includes(wanted)))?.[0] ?? null;
}

/**
 * Turns "Fix login @proj #tag" into a description plus the first matching
 * project and tags. Words whose @/# reference matches nothing stay text.
 */
export function parseDraft(query, projects, tags) {
    const words = [];
    let project = null;
    const picked = [];

    for (const word of query.split(/\s+/).filter(Boolean)) {
        const [sigil, name] = [word[0], word.slice(1)];
        const match = !name ? null
            : sigil === '@' && !project ? findByName(projects, name)
                : sigil === '#' ? findByName(tags, name) : null;

        if (!match)
            words.push(word);
        else if (sigil === '@')
            project = match;
        else if (!picked.includes(match))
            picked.push(match);
    }

    return {description: words.join(' '), project, tags: picked};
}

/** Collapses the time entry history into distinct recent tasks, newest first. */
function distinctTasks(timeEntries, projects, tags) {
    const projectsById = new Map(projects.map(p => [p.id, p]));
    const tagsById = new Map(tags.map(t => [t.id, t]));
    const seen = new Map();

    for (const e of timeEntries) {
        const projectId = e.projectId ?? e.project?.id ?? undefined;
        const taskId = e.taskId ?? e.task?.id ?? undefined;
        const tagIds = e.tagIds ?? e.tags?.map(t => t.id) ?? [];
        const description = e.description ?? '';
        const id = JSON.stringify([description, projectId, taskId, [...tagIds].sort(), !!e.billable]);
        if (seen.has(id))
            continue;

        const project = projectsById.get(projectId) ?? e.project;
        seen.set(id, {
            id,
            description,
            projectId,
            taskId,
            tagIds,
            billable: !!e.billable,
            projectName: project?.name ?? '',
            clientName: project?.clientName ?? '',
            color: project?.color ?? null,
            taskName: e.task?.name ?? '',
            tagNames: tagIds.map(t => tagsById.get(t)?.name ??
                e.tags?.find(tag => tag.id === t)?.name).filter(Boolean),
            start: e.timeInterval?.start,
            running: !e.timeInterval?.end,
        });
    }
    return [...seen.values()];
}

function searchFields(task) {
    return [
        [10, task.description],
        [5, task.projectName],
        [5, task.taskName],
        [3, task.tagNames],
        [2, task.clientName],
    ];
}

function describe(task) {
    const project = [task.projectName, task.taskName].filter(Boolean).join(': ');
    const tags = task.tagNames.map(t => `#${t}`).join(' ');

    if (task.isNew) {
        return {
            icon: 'list-add-symbolic',
            title: task.description || '(no description)',
            subtitle: ['New entry', project, tags].filter(Boolean).join('  ·  '),
        };
    }
    return {
        icon: 'media-playback-start-symbolic',
        iconStyle: task.color ? `color: ${task.color};` : null,
        title: task.description || '(no description)',
        subtitle: [task.running && 'Running', project, task.clientName, tags]
            .filter(Boolean).join('  ·  '),
    };
}

/**
 * Last fetched tasks, projects and tags on disk, so the launcher has
 * something to show right away, even after a restart.
 */
class Cache {
    constructor() {
        this._file = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'quick-launcher', 'clockify.json']));
    }

    load(account) {
        try {
            const [, bytes] = this._file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            return data.account === account ? data : null;
        } catch {
            return null;
        }
    }

    async save(data) {
        try {
            this._file.get_parent().make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }
        await this._file.replace_contents_async(new TextEncoder().encode(JSON.stringify(data)),
            null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
}

function localTime(iso) {
    return GLib.DateTime.new_from_iso8601(iso, null)?.to_local().format('%H:%M') ?? '';
}

/** Starts Clockify timers for recent or new tasks. */
export class Clockify {
    constructor(settings) {
        this._settings = settings;
        this._api = new ClockifyApi(settings);
        this._cache = new Cache();
        this._launcher = new Launcher({
            icon: 'alarm-symbolic',
            placeholder: 'Start time entry…',
            hints: HINTS,
            search: (tasks, query) => this._search(tasks, query),
            describe,
            actionFor: ({enter, shift}) => enter ? shift ? 'new' : 'start' : null,
            commands: {
                r: () => this._reload(),
                s: () => this._stop(),
            },
            onActivate: (task, action) => this._start(task, action),
        });
        this._tasks = [];
        this._projects = [];
        this._tags = [];
        this._account = null;
    }

    destroy() {
        this._launcher.destroy();
        this._launcher = null;
        this._api.destroy();
    }

    toggle() {
        if (this._launcher.isOpen) {
            this._launcher.close();
            return;
        }
        this._loadCache();
        this._launcher.setEntries(this._tasks);
        this._showStatus();
        this._launcher.open({
            query: this._settings.get_string('clockify-last-query'),
            selectedId: this._settings.get_string('clockify-last-entry-id'),
        });
        this._reload();
    }

    /** Fills in the last fetched data, unless it belongs to another account. */
    _loadCache() {
        const account = this._api.account;
        if (this._account === account)
            return;

        this._account = account;
        const {tasks = [], projects = [], tags = []} = this._cache.load(account) ?? {};
        this._setData(tasks, projects, tags);
    }

    _setData(tasks, projects, tags) {
        this._projects = projects;
        this._tags = tags;
        this._tasks = prepare(tasks, searchFields);
    }

    _showStatus(loaded = false) {
        if (!loaded && !this._tasks.length) {
            this._launcher.setStatus('Loading…');
            return;
        }
        const running = this._tasks.find(t => t.running);
        this._launcher.setStatus(running
            ? `▶ ${running.description || running.projectName || 'Timer'} since ${localTime(running.start)}`
            : null);
    }

    _search(tasks, query) {
        const results = search(tasks, query.replace(/(^|\s)[@#]/g, '$1'));
        const draft = this._draft(query);
        if (draft.description || draft.projectId)
            results.push(draft);
        return results;
    }

    _draft(query) {
        const {description, project, tags} = parseDraft(query, this._projects, this._tags);
        return {
            id: 'new',
            isNew: true,
            description,
            projectId: project?.id,
            billable: project?.billable ?? false,
            tagIds: tags.map(t => t.id),
            projectName: project?.name ?? '',
            taskName: '',
            tagNames: tags.map(t => t.name),
        };
    }

    async _reload() {
        if (!this._api.configured) {
            this._launcher.setStatus('Set your Clockify API key in the extension preferences');
            return;
        }
        try {
            const account = this._api.account;
            const [timeEntries, allProjects, allTags] = await Promise.all([
                this._api.recent(), this._api.projects(), this._api.tags(),
            ]);
            if (!this._launcher)
                return;

            // Only what parseDraft() and distinctTasks() need, to keep the cache small.
            const projects = allProjects.map(({id, name, billable, clientName, color}) =>
                ({id, name, billable, clientName, color}));
            const tags = allTags.map(({id, name}) => ({id, name}));
            const tasks = distinctTasks(timeEntries, projects, tags);

            this._account = account;
            this._setData(tasks, projects, tags);
            this._launcher.setEntries(this._tasks);
            this._showStatus(true);

            this._cache.save({account, tasks, projects, tags}).catch(e =>
                console.error('quick-launcher: Could not write Clockify cache', e));
        } catch (e) {
            console.error('quick-launcher: Clockify request failed', e);
            this._launcher?.setStatus(`Clockify: ${e.message}`);
        }
    }

    async _start(task, action) {
        this._settings.set_string('clockify-last-query', this._launcher.query);
        this._settings.set_string('clockify-last-entry-id', task.id);

        if (action === 'new' || task.isNew)
            task = this._draft(this._launcher.query);
        if (!task.description && !task.projectId)
            return;

        try {
            await this._api.start(task);
            osd('media-playback-start-symbolic',
                task.description || task.projectName || 'Timer started');
        } catch (e) {
            fail('Could not start Clockify timer', e);
        }
    }

    async _stop() {
        this._launcher.close();
        try {
            if (await this._api.stop())
                osd('media-playback-stop-symbolic', 'Timer stopped');
            else
                Main.notify('Clockify', 'No timer running');
        } catch (e) {
            fail('Could not stop Clockify timer', e);
        }
    }
}

function osd(icon, label) {
    Main.osdWindowManager.showOne(Main.layoutManager.currentMonitor.index,
        new Gio.ThemedIcon({name: icon}), label, null, undefined);
}

function fail(message, error) {
    console.error(`quick-launcher: ${message}`, error);
    Main.notifyError(message, error.message);
}
