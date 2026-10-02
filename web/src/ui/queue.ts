// The queue: add files one after another (each with its own orientation and preset), choose an
// output folder once, and they are converted one by one — e.g. overnight. A failed file does not
// stop the queue (out of memory → one retry with less RAM, GPU failure → one retry without GPU).
// The queue is remembered in IndexedDB: after a closed or crashed tab it resumes with one click.

import type { PlanInfo } from '../engine/plan';
import type { OutputTarget } from '../engine/protocol';
import { track } from './api';
import {
    checkCrash, editInEditor, editorFile, editorJob, getProgress, hintFor, hooks, isRunning, keepAwake, nextFile,
    opfsDownloadLink, outputNameFor, pickFiles, runJob, runningJobId, updateButtons, type InputSummary, type JobSpec, type Outcome
} from './converter';
import { fmtBytes, fmtDuration, fmtInt, locale, t } from './i18n';
import { idbDel, idbGet, idbSet } from './queue-store';
import { acquire, releaseLock } from './tab-lock';
import type { UiSettings } from './settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const KEY = 'queue_v1';
const GB = 1024 ** 3;
const MAX_AUTO_RETRIES = 2;

type Status = 'waiting' | 'editing' | 'running' | 'done' | 'failed' | 'cancelled' | 'missing';

interface Item {
    id: string;
    name: string;
    size: number;
    lastModified: number;
    input: InputSummary;
    settings: UiSettings;
    preset: string;
    plan: PlanInfo;
    status: Status;
    /** status before "Edit" — restored if the edit is abandoned */
    prevStatus?: Status;
    attempts: number;
    autoRetries: number;
    note?: string;
    outputName?: string;
    outputKind?: 'fsa' | 'opfs';
    result?: { counts: number[]; bytes: number; seconds: number; verifyOk: boolean; verifyErrors: string[] };
    error?: { message: string; stage: string; reportId: string | null; details: string; hint: string };
    addedAt: number;
    startedAt?: number;
    finishedAt?: number;
    handle?: FileSystemFileHandle;
    /** runtime only — never persisted (IndexedDB would copy the whole file) */
    file?: File;
}

interface Saved {
    items: Omit<Item, 'file'>[];
    dir: FileSystemDirectoryHandle | null;
    paused: boolean;
    startedAt?: number;
    savedAt: number;
}

const st: { items: Item[]; dir: FileSystemDirectoryHandle | null; active: boolean; paused: boolean; startedAt?: number } = {
    items: [], dir: null, active: false, paused: false
};
let editingId: string | null = null;
const downloads = new Map<string, Promise<HTMLAnchorElement>>();
let pumping = false;
let announced = false;

type PermHandle = FileSystemHandle & {
    queryPermission?(o: { mode: string }): Promise<PermissionState>;
    requestPermission?(o: { mode: string }): Promise<PermissionState>;
};
const hasDirPicker = () => typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const waiting = () => st.items.filter(i => i.status === 'waiting');
const current = () => st.items.find(i => i.status === 'running');
const queueBusy = () => !!current() || (st.active && !st.paused && waiting().length > 0);

// ---------- persistence
// Written at once, in order: a status change must survive a tab that dies right after it
// (a debounced write lost "done" when the tab closed 0.1 s later, and the file ran again).
let saveChain: Promise<unknown> = Promise.resolve();
const persist = () => {
    const saved: Saved | null = st.items.length ? {
        items: st.items.map(({ file: _file, ...rest }) => rest),
        dir: st.dir,
        paused: st.paused,
        startedAt: st.startedAt,
        savedAt: Date.now()
    } : null;
    saveChain = saveChain.then(async () => {
        if (saved) await idbSet(KEY, saved);
        else await idbDel(KEY);
    });
};

const ensurePerm = async (h: FileSystemHandle, mode: 'read' | 'readwrite') => {
    const p = h as PermHandle;
    try {
        if ((await p.queryPermission?.({ mode })) === 'granted') return true;
        return (await p.requestPermission?.({ mode })) === 'granted';
    } catch {
        return false; // e.g. no user activation left: the next click asks again
    }
};

// ---------- adding
const itemFromJob = (job: JobSpec): Item => ({
    id: job.id,
    name: job.file.name,
    size: job.file.size,
    lastModified: job.file.lastModified,
    input: job.input,
    settings: job.settings,
    preset: job.preset,
    plan: job.plan,
    status: 'waiting',
    attempts: 0,
    autoRetries: 0,
    addedAt: Date.now(),
    handle: job.handle,
    file: job.file
});

const say = (text: string, ok = true) => {
    const m = $('q-msg');
    m.textContent = text;
    m.className = `small o-msg${ok ? ' ok' : ''}`;
};

const enqueue = async () => {
    if (!(await acquire())) {
        say(t('queue.otherTab'), false);
        return;
    }
    const editId = editingId;
    const job = await editorJob();
    if (!job) return;
    const editing = editId ? st.items.find(i => i.id === editId && i.status === 'editing' && i.file === job.file) : undefined;
    if (editing) {
        // put the edited file back where it was, with the new choices
        const fresh = itemFromJob(job);
        Object.assign(editing, { ...fresh, id: editing.id, addedAt: editing.addedAt, outputName: editing.outputName, outputKind: editing.outputKind, prevStatus: undefined });
        if (editingId === editId) editingId = null;
    } else {
        st.items.push(itemFromJob(job));
    }
    announced = false;
    persist();
    track('queue_add', String(st.items.length), { splats: job.input.vertexCount, preset: job.preset });
    say(t('queue.added', { name: job.file.name }));
    nextFile();
    render();
    if (st.active && !st.paused) pump();
};

// ---------- output
const exists = async (dir: FileSystemDirectoryHandle, name: string) => {
    try {
        await dir.getFileHandle(name);
        return true;
    } catch {
        return false;
    }
};

const outputFor = async (item: Item): Promise<OutputTarget> => {
    const dir = st.dir ?? await navigator.storage.getDirectory();
    let name = item.outputName;
    if (!name) {
        // never overwrite: not a file already in the folder, not a name another queued file will use
        for (let n = 1; ; n++) {
            const c = outputNameFor(item.name, n);
            if (st.items.some(o => o !== item && o.outputName === c)) continue;
            if (await exists(dir, c)) continue;
            name = c;
            break;
        }
    }
    item.outputName = name;
    if (st.dir) {
        item.outputKind = 'fsa';
        return { kind: 'fsa', handle: await st.dir.getFileHandle(name, { create: true }) };
    }
    item.outputKind = 'opfs';
    return { kind: 'opfs', name };
};

/** A failed run leaves an empty file behind (the writer discards its data on abort): remove it. */
const removeEmptyOutput = async (item: Item) => {
    if (!item.outputName) return;
    try {
        const dir = st.dir ?? await navigator.storage.getDirectory();
        const fh = await dir.getFileHandle(item.outputName);
        if ((await fh.getFile()).size === 0) {
            await dir.removeEntry(item.outputName);
            item.outputName = undefined;
        }
    } catch { /* gone already */ }
};

// ---------- running
const specOf = (item: Item): JobSpec => ({
    id: item.id,
    file: item.file!,
    handle: item.handle,
    input: item.input,
    settings: item.settings,
    preset: item.preset as JobSpec['preset'],
    plan: item.plan
});

/** Pick a retry that has a real chance, or null. */
const autoRetry = (item: Item, o: Extract<Outcome, { ok: false }>): string | null => {
    if (item.autoRetries >= MAX_AUTO_RETRIES) return null;
    const m = `${o.error.name} ${o.error.message}`;
    if (/GPU|WebGPU|device lost/i.test(m) && item.settings.useGpu) {
        item.settings = { ...item.settings, useGpu: false };
        return t('queue.retryGpu');
    }
    if ((/memory|allocation|Array buffer|WorkerError/i.test(m) || o.stage === 'header' && o.error.name === 'WorkerError') && item.settings.memoryBytes > 2 * GB) {
        const gb = Math.max(2, Math.floor((item.settings.memoryBytes / GB) * 0.6));
        item.settings = { ...item.settings, memoryBytes: gb * GB };
        return t('queue.retryMem', { gb });
    }
    return null;
};

const applyOutcome = async (item: Item, o: Outcome) => {
    item.finishedAt = Date.now();
    if (o.ok) {
        item.status = 'done';
        item.outputName = o.outputName;
        item.note = undefined;
        item.error = undefined;
        item.result = { counts: o.result.counts, bytes: o.result.archiveBytes, seconds: o.result.seconds, verifyOk: o.verify.ok, verifyErrors: o.verify.errors.slice(0, 5) };
        return;
    }
    item.error = { message: `${o.error.name}: ${o.error.message}`, stage: o.stage, reportId: o.reportId, details: o.details, hint: hintFor(o.error.message, o.stage) };
    if (o.cancelled) {
        item.status = 'cancelled';
        item.error = undefined;
        st.paused = true; // the user stopped it: do not run on into the next file
        await removeEmptyOutput(item);
        return;
    }
    const retry = autoRetry(item, o);
    if (retry) {
        item.status = 'waiting';
        item.autoRetries++;
        item.note = retry;
    } else {
        item.status = 'failed';
        item.note = undefined;
        await removeEmptyOutput(item);
    }
};

/** Load the file of an item restored after a reload (permission was asked on Resume). */
const fileOf = async (item: Item): Promise<File | null> => {
    if (item.file) return item.file;
    if (!item.handle) return null;
    try {
        const f = await item.handle.getFile();
        // the same file as when it was queued (its orientation and settings were chosen for it)
        return f.size === item.size && f.lastModified === item.lastModified ? f : null;
    } catch {
        return null;
    }
};

const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
        while (st.active && !st.paused && !isRunning()) {
            const item = waiting()[0];
            if (!item) break;
            const f = await fileOf(item);
            if (!f) {
                item.status = 'missing';
                persist();
                render();
                continue;
            }
            item.file = f;
            let output: OutputTarget;
            try {
                output = await outputFor(item);
            } catch (e) {
                // the folder is gone or access was withdrawn: wait for the user
                st.paused = true;
                say(`${t('queue.folderProblem')} ${(e as Error).message}`, false);
                break;
            }
            item.status = 'running';
            item.attempts++;
            item.startedAt = Date.now();
            item.error = undefined;
            persist();
            render();
            keepAwake(true);
            const i = st.items.indexOf(item) + 1;
            const n = st.items.length;
            const o = await runJob(specOf(item), output, {
                mode: 'queue',
                jobLabel: t('queue.job', { i, n, name: item.name }),
                titlePrefix: t('queue.titleShort', { i, n })
            });
            await applyOutcome(item, o);
            persist();
            render();
            // let the finished worker's memory go before the next file starts
            await sleep(1500);
        }
    } finally {
        pumping = false;
        if (!queueBusy()) {
            keepAwake(false);
            maybeAnnounce();
        }
        render();
        updateButtons();
    }
};

const maybeAnnounce = () => {
    if (announced || !st.active || st.paused || current() || waiting().length) return;
    const done = st.items.filter(i => i.status === 'done');
    const failed = st.items.filter(i => i.status === 'failed');
    if (!done.length && !failed.length) return;
    announced = true;
    const total = st.startedAt ? (Date.now() - st.startedAt) / 1000 : done.reduce((a, i) => a + (i.result?.seconds ?? 0), 0);
    const box = $('q-done');
    box.textContent = t('queue.finished', { time: new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }), done: done.length, failed: failed.length, dur: fmtDuration(total) });
    box.className = `banner ${failed.length ? 'warn' : 'ok'}`;
    box.hidden = false;
    document.title = `${failed.length ? `✗ ${t('queue.titleFailed', { failed: failed.length })}` : `✓ ${t('queue.titleDone')}`} · Shramko SOG LOD Converter`;
    track('queue_done', String(done.length), { failed: failed.length, seconds: Math.round(total) });
    st.startedAt = undefined;
    persist();
};

// ---------- controls
const start = async () => {
    if (!waiting().length && !current()) {
        if (st.items.some(i => i.status === 'missing')) {
            // files without a stored handle (Firefox/Safari, or picked through the plain dialog)
            say(t('queue.pickAgain'), false);
            pickFiles();
        }
        return;
    }
    if (!(await acquire())) {
        say(t('queue.otherTab'), false);
        return;
    }
    if (!st.dir && hasDirPicker()) {
        try {
            st.dir = await (window as unknown as { showDirectoryPicker(o: unknown): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'sog-queue-out', mode: 'readwrite', startIn: 'downloads' });
        } catch (e) {
            if ((e as Error).name === 'AbortError') {
                say(t('queue.needFolder'), false);
                return;
            }
            throw e;
        }
    } else if (st.dir && !(await ensurePerm(st.dir, 'readwrite'))) {
        say(t('queue.resumeDenied'), false);
        return;
    }
    // files restored after a reload: ask to read them again (needs this click's activation)
    let denied = 0;
    for (const i of st.items) {
        if (i.status !== 'waiting' || i.file || !i.handle) continue;
        if (await ensurePerm(i.handle, 'read')) {
            const f = await fileOf(i);
            if (f) i.file = f; else i.status = 'missing';
        } else {
            denied++;
        }
    }
    if (denied) {
        say(t('queue.resumeDenied'), false);
        render();
        return;
    }
    $('q-resume').hidden = true;
    if (!st.dir) await checkBrowserStorage();
    st.active = true;
    st.paused = false;
    st.startedAt ??= Date.now();
    announced = false;
    $('q-done').hidden = true;
    $('q-msg').textContent = '';
    persist();
    track('queue_start', String(waiting().length));
    render();
    pump();
};

/** Without a folder the results stay in browser storage: ask to keep it, warn when it will not fit. */
const checkBrowserStorage = async () => {
    try {
        await navigator.storage.persist?.();
        const est = await navigator.storage.estimate();
        const free = (est.quota ?? 0) - (est.usage ?? 0);
        const need = waiting().reduce((a, i) => a + i.plan.estimatedOutputBytes, 0);
        if (est.quota && need > free) say(t('queue.opfsQuota', { need: fmtBytes(need), free: fmtBytes(Math.max(0, free)) }), false);
    } catch { /* no estimate: go on */ }
};

const changeFolder = async () => {
    if (current()) return;
    try {
        st.dir = await (window as unknown as { showDirectoryPicker(o: unknown): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'sog-queue-out', mode: 'readwrite', startIn: 'downloads' });
        for (const i of st.items) if (i.status !== 'done') i.outputName = undefined;
        persist();
        render();
    } catch { /* cancelled */ }
};

const resume = () => start();

const discard = async () => {
    st.items = [];
    st.dir = null;
    st.active = false;
    st.paused = false;
    await idbDel(KEY);
    $('q-resume').hidden = true;
    render();
    updateButtons();
    maybeRelease();
};

/** Nothing queued and nothing running: let another tab work. */
const maybeRelease = () => {
    if (!st.items.length && !isRunning()) releaseLock();
};

const act = async (item: Item, action: string) => {
    const idx = st.items.indexOf(item);
    switch (action) {
        case 'remove':
            if (item.status === 'running') return;
            if (item.status === 'done' && item.outputKind === 'opfs' && item.outputName) {
                // the only copy lives in browser storage
                if (!confirm(t('queue.deleteOpfs', { name: item.outputName }))) return;
                const name = item.outputName;
                await navigator.storage.getDirectory().then(d => d.removeEntry(name)).catch(() => undefined);
                downloads.delete(name);
            }
            if (editingId === item.id) editingId = null;
            st.items.splice(st.items.indexOf(item), 1);
            break;
        case 'up':
            if (idx > 0) [st.items[idx - 1], st.items[idx]] = [st.items[idx], st.items[idx - 1]];
            break;
        case 'down':
            if (idx < st.items.length - 1) [st.items[idx + 1], st.items[idx]] = [st.items[idx], st.items[idx + 1]];
            break;
        case 'retry':
            if (!item.file && item.handle && await ensurePerm(item.handle, 'read')) {
                // restored after a reload: this click may ask for the file again
                const f = await fileOf(item);
                if (f) item.file = f;
            }
            item.status = item.file ? 'waiting' : 'missing';
            item.autoRetries = 0;
            item.error = undefined;
            item.note = undefined;
            announced = false;
            break;
        case 'edit': {
            if (!item.file) return;
            const prev = editingId ? st.items.find(i => i.id === editingId) : undefined;
            if (prev?.status === 'editing') {
                prev.status = prev.prevStatus ?? 'waiting';
                prev.prevStatus = undefined;
            }
            // the editor holds the previous item's file: do not offer it again as a new file
            const keepCurrent = !(prev && editorFile() === prev.file);
            editingId = item.id;
            item.prevStatus = item.status;
            item.status = 'editing';
            editInEditor(item.file, item.handle, item.settings, keepCurrent);
            break;
        }
        case 'repick':
            pickFiles();
            return;
        case 'download':
            return;
    }
    announced = false;
    persist();
    render();
    updateButtons();
    maybeRelease();
    if (st.active && !st.paused) pump();
};

// ---------- rendering
const presetLabel = (id: string) => (id === 'custom' ? t('queue.custom') : t(`preset.${id}`).split(/\s+[—–]\s+|:\s+/)[0]);
const turnText = (r: [number, number, number]) => {
    const parts = (['X', 'Y', 'Z'] as const).map((a, k) => (r[k] ? `${a} ${r[k] > 0 ? '+' : '−'}${Math.abs(r[k])}°` : '')).filter(Boolean);
    return parts.length ? t('queue.turned', { r: parts.join(', ') }) : t('queue.notTurned');
};

const stateText = (item: Item) => {
    switch (item.status) {
        case 'waiting':
            return `${t('queue.waiting', { time: fmtDuration(item.plan.estimatedSeconds) })}${item.note ? ` · ${item.note}` : ''}`;
        case 'editing':
            return t('queue.editing');
        case 'running': {
            const p = getProgress();
            return t('queue.running', { pct: `${Math.round(p.overall * 100)}%`, eta: p.eta !== undefined ? fmtDuration(p.eta) : '—' });
        }
        case 'done': {
            const r = item.result!;
            const base = t('queue.done', { levels: r.counts.length, size: fmtBytes(r.bytes), time: fmtDuration(r.seconds), out: item.outputName ?? '' });
            return r.verifyOk ? base : `${base} · ${t('queue.doneWarn')}: ${r.verifyErrors[0] ?? ''}`;
        }
        case 'failed':
            return `${t('queue.failed', { msg: item.error?.message ?? '' })}${item.error?.reportId ? ` · ${t('queue.reported', { id: item.error.reportId })}` : ''}${item.error?.hint ? ` — ${item.error.hint}` : ''}`;
        case 'cancelled':
            return t('queue.cancelled');
        case 'missing':
            return t('queue.missing');
    }
};

const button = (label: string, action: string, cls = 'btn ghost small') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.dataset.act = action;
    return b;
};

const render = () => {
    const box = $('queue');
    box.hidden = st.items.length === 0;
    if (box.hidden) return;
    const ol = $('q-list');
    ol.innerHTML = '';
    st.items.forEach((item, k) => {
        const li = document.createElement('li');
        li.className = `q-item ${item.status}`;
        li.dataset.id = item.id;
        const main = document.createElement('div');
        main.className = 'q-main';
        const b = document.createElement('b');
        b.textContent = item.name;
        const meta = document.createElement('span');
        meta.className = 'q-meta muted small';
        meta.textContent = `${fmtInt(item.input.vertexCount)} ${t('app.splats').toLowerCase()} · ${t('queue.levels', { n: item.plan.levels.length })} · ${presetLabel(item.preset)} · ${turnText(item.settings.rotation)}`;
        main.append(b, meta);
        const state = document.createElement('div');
        state.className = 'q-state small';
        state.textContent = stateText(item);
        const acts = document.createElement('div');
        acts.className = 'q-acts';
        if (item.status === 'waiting' || item.status === 'missing' || item.status === 'cancelled' || item.status === 'failed') {
            if (k > 0) acts.appendChild(button('↑', 'up'));
            if (k < st.items.length - 1) acts.appendChild(button('↓', 'down'));
        }
        if ((item.status === 'waiting' || item.status === 'failed' || item.status === 'cancelled') && item.file) acts.appendChild(button(t('queue.edit'), 'edit'));
        if (item.status === 'failed' || item.status === 'cancelled') acts.appendChild(button(t('queue.retry'), 'retry'));
        if (item.status === 'missing') acts.appendChild(button(t('queue.repick'), 'repick'));
        if (item.status === 'failed' && item.error?.details) {
            const c = button(t('ui.errCopy'), 'copy');
            c.addEventListener('click', () => navigator.clipboard.writeText(item.error!.details).then(() => {
                c.textContent = t('ui.copied');
            }));
            acts.appendChild(c);
        }
        if (item.status === 'done' && item.outputKind === 'opfs' && item.outputName) {
            const name = item.outputName;
            if (!downloads.has(name)) downloads.set(name, opfsDownloadLink(name));
            downloads.get(name)!.then((a) => {
                a.className = 'btn primary small';
                acts.prepend(a);
            }).catch(() => undefined);
        }
        if (item.status !== 'running') acts.appendChild(button('×', 'remove', 'btn ghost small q-x'));
        acts.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((btn) => {
            const a = btn.dataset.act!;
            if (a === 'copy') return;
            btn.setAttribute('aria-label', a === 'up' ? t('queue.up') : a === 'down' ? t('queue.down') : a === 'remove' ? t('queue.remove') : btn.textContent ?? a);
            btn.addEventListener('click', () => {
                act(item, a).catch(e => say((e as Error).message, false));
            });
        });
        li.append(main, state, acts);
        ol.appendChild(li);
    });

    const done = st.items.filter(i => i.status === 'done').length;
    const failed = st.items.filter(i => i.status === 'failed').length;
    const run = current();
    const left = waiting().reduce((a, i) => a + i.plan.estimatedSeconds, 0) + (run ? getProgress().eta ?? run.plan.estimatedSeconds : 0);
    const bytes = waiting().reduce((a, i) => a + i.plan.estimatedOutputBytes, 0) + (run ? run.plan.estimatedOutputBytes : 0);
    $('q-summary').textContent = t('queue.summary', { n: st.items.length, done, failed, time: fmtDuration(left), size: fmtBytes(bytes) });

    $('q-folder').textContent = st.dir ? t('queue.folder', { name: st.dir.name }) : hasDirPicker() ? t('queue.folderAsk') : t('queue.folderOpfs');
    $('q-folder-change').hidden = !st.dir || !!run || !hasDirPicker();

    const startBtn = $<HTMLButtonElement>('q-start');
    const pauseBtn = $<HTMLButtonElement>('q-pause');
    const runningQueue = st.active && !st.paused && (!!run || waiting().length > 0);
    startBtn.hidden = runningQueue;
    startBtn.disabled = waiting().length === 0;
    startBtn.textContent = st.active && st.paused ? t('queue.continue') : t('queue.start');
    pauseBtn.hidden = !runningQueue;
    $('q-paused').hidden = !(st.paused && !!run);
    $('q-clear').hidden = done === 0;
};

/** Live status of the running item, without rebuilding the list. */
let lastLive = 0;
const live = () => {
    const now = Date.now();
    if (now - lastLive < 1000) return;
    lastLive = now;
    const id = runningJobId();
    const item = id ? st.items.find(i => i.id === id) : undefined;
    if (!item) return;
    const el = document.querySelector<HTMLElement>(`#q-list li[data-id="${CSS.escape(item.id)}"] .q-state`);
    if (el) el.textContent = stateText(item);
    const run = current();
    if (run) {
        const left = waiting().reduce((a, i) => a + i.plan.estimatedSeconds, 0) + (getProgress().eta ?? run.plan.estimatedSeconds);
        const bytes = waiting().reduce((a, i) => a + i.plan.estimatedOutputBytes, 0) + run.plan.estimatedOutputBytes;
        const done = st.items.filter(i => i.status === 'done').length;
        const failed = st.items.filter(i => i.status === 'failed').length;
        $('q-summary').textContent = t('queue.summary', { n: st.items.length, done, failed, time: fmtDuration(left), size: fmtBytes(bytes) });
    }
};

const summaryText = () => st.items.map((i, k) => {
    const r = i.result;
    const what = i.status === 'done' && r ?
        `done — ${r.counts.length} levels — ${fmtBytes(r.bytes)} — ${fmtDuration(r.seconds)} — ${i.outputName}${r.verifyOk ? '' : ` — CHECK FAILED: ${r.verifyErrors[0] ?? ''}`}` :
        i.status === 'failed' ? `FAILED — ${i.error?.message ?? ''}${i.error?.reportId ? ` (report ${i.error.reportId})` : ''}` : i.status;
    return `${k + 1}. ${i.name} (${fmtInt(i.input.vertexCount)} splats, ${presetLabel(i.preset)}, ${turnText(i.settings.rotation)}) — ${what}`;
}).join('\n');

// ---------- restore after a reload
const restore = async () => {
    // another tab is working (or owns the saved queue): its state is not ours to resume
    if (!(await acquire())) {
        const box = $('other-tab');
        box.textContent = t('queue.otherTab');
        box.hidden = false;
        return;
    }
    checkCrash();
    const saved = await idbGet<Saved>(KEY);
    if (!saved?.items?.length) {
        releaseLock();
        return;
    }
    st.items = saved.items.map(i => ({
        ...i,
        status: i.status === 'running' ? 'waiting' : i.status === 'editing' ? i.prevStatus ?? 'waiting' : i.status,
        prevStatus: undefined,
        note: i.status === 'running' ? t('queue.restarted') : i.note
    }));
    for (const i of st.items) if (i.status === 'waiting' && !i.handle) i.status = 'missing';
    st.dir = saved.dir ?? null;
    st.paused = saved.paused ?? false;
    st.startedAt = saved.startedAt;
    st.active = false;
    const left = st.items.filter(i => i.status === 'waiting' || i.status === 'missing').length;
    render();
    updateButtons();
    if (left > 0) {
        const ago = fmtDuration((Date.now() - saved.savedAt) / 1000);
        $('q-resume-text').textContent = t('queue.resumeTitle', { ago, left });
        $('q-resume').hidden = false;
    }
};

export const initQueue = () => {
    hooks.queueBusy = queueBusy;
    hooks.onProgress = live;
    hooks.claimFile = (f, h) => {
        // the same file can be queued twice (e.g. two presets): attach it to every matching item
        const its = st.items.filter(i => i.status === 'missing' && i.name === f.name && i.size === f.size);
        if (!its.length) return false;
        for (const it of its) {
            it.file = f;
            if (h) it.handle = h;
            it.status = 'waiting';
            it.note = t('queue.reattached');
        }
        persist();
        render();
        updateButtons();
        say(t('queue.reattachedMsg', { name: f.name }));
        if (st.active && !st.paused) pump();
        return true;
    };
    hooks.onEditorChange = () => {
        // an item taken into the editor goes back to waiting if the editor moved on to another file
        if (!editingId) return;
        const it = st.items.find(i => i.id === editingId);
        if (it && it.file !== editorFile()) {
            if (it.status === 'editing') {
                it.status = it.prevStatus ?? 'waiting';
                it.prevStatus = undefined;
            }
            editingId = null;
            persist();
            render();
            if (st.active && !st.paused) pump();
        }
        $('enqueue').textContent = editingId ? t('queue.putBack') : t('app.enqueue');
    };
    $('enqueue').addEventListener('click', () => {
        enqueue().catch(e => say((e as Error).message, false));
    });
    $('q-start').addEventListener('click', () => {
        start().catch(e => say((e as Error).message, false));
    });
    $('q-pause').addEventListener('click', () => {
        st.paused = true;
        persist();
        render();
        updateButtons();
    });
    $('q-folder-change').addEventListener('click', changeFolder);
    $('q-copy').addEventListener('click', () => navigator.clipboard.writeText(summaryText()).then(() => say(t('ui.copied'))));
    $('q-clear').addEventListener('click', () => {
        // results kept only in browser storage stay listed (their Download button is the only way to them)
        st.items = st.items.filter(i => i.status !== 'done' || i.outputKind === 'opfs');
        persist();
        render();
        maybeRelease();
    });
    $('q-resume-go').addEventListener('click', () => {
        resume().catch(e => say((e as Error).message, false));
    });
    $('q-resume-drop').addEventListener('click', discard);
    // a single run that blocked the queue has ended, or a queue item ended outside the loop
    hooks.onRunEnd = () => {
        if (st.active && !st.paused) setTimeout(pump, 1500);
        else setTimeout(maybeRelease, 0);
    };
    restore();
};
