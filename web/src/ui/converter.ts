// The converter panel: pick a file, preview the plan, run the worker, show progress,
// the result or the error — and report errors so they can be fixed.
//
// Two ways to run: "Convert" (one file, a save dialog) and the queue (queue.ts: many files, one
// output folder, one after another). Both go through runJob(); the file panel ("editor") stays
// usable while a job runs, so the next files can be checked and queued meanwhile.

import { parsePlyHeader, type PlyHeader } from '../engine/ply-header';
import { previewPlan, type PlanInfo, type Stage } from '../engine/plan';
import type { PipelineResult } from '../engine/pipeline';
import type { FromWorker, OutputTarget, StartMessage, WorkerErrorInfo } from '../engine/protocol';
import type { VerifyReport } from '../engine/verify';
import { sendReport, sizeBucket, track } from './api';
import { browserInfo, describe, getRelease, gpuInfo, recentErrors } from './diagnostics';
import { fmtBytes, fmtDuration, fmtInt, lang, t } from './i18n';
import { loadSettings, readForm, saveSettings, writeForm, defaults, type UiSettings } from './settings';
import { PRESETS, VIEWER_BUDGETS, matchPreset, type PresetId } from '../engine/presets';
import { initOrientationPanel, loadOrientation, orientationForConversion } from './orient-panel';
import { acquire } from './tab-lock';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const RUN_KEY = 'sog_run_v1';
const REPORT_PREF = 'sog_auto_report';

/** What a job needs to know about its input (kept small: it is also persisted with the queue). */
export interface InputSummary {
    vertexCount: number;
    shBands: number;
    format: string;
    extraProperties: string[];
    stride: number;
}

/** One conversion: a file plus a snapshot of everything chosen for it. */
export interface JobSpec {
    id: string;
    file: File;
    handle?: FileSystemFileHandle;
    input: InputSummary;
    settings: UiSettings;          // rotation/translation included (per file)
    preset: PresetId | 'custom';
    plan: PlanInfo;                // the estimate shown when it was set up
}

export type Outcome =
    | { ok: true; result: Omit<PipelineResult, 'meta'>; verify: VerifyReport; outputName: string }
    | { ok: false; error: WorkerErrorInfo; stage: Stage; detail: string; cancelled: boolean; reportId: string | null; details: string };

export interface RunOptions {
    mode: 'single' | 'queue';
    /** shown above the progress bar and in the tab title, e.g. "File 2 of 5: city.ply" */
    jobLabel?: string;
    titlePrefix?: string;
}

/** Hooks the queue plugs in (keeps this module free of a queue import). */
export const hooks = {
    /** a picked file may belong to the queue (re-adding a file after a reload): return true to take it */
    claimFile: (_f: File, _h?: FileSystemFileHandle) => false,
    /** is the queue holding work (affects the Convert button and the leave-page warning) */
    queueBusy: () => false,
    onProgress: (_p: { overall: number; eta?: number }) => undefined as void,
    onEditorChange: () => undefined as void,
    /** any run (single or queue) has ended: the queue may be waiting for the converter to be free */
    onRunEnd: () => undefined as void
};

// ---------- editor state (the file being looked at / set up)
let file: File | null = null;
let fileHandle: FileSystemFileHandle | undefined;
let header: PlyHeader | null = null;
let settings: UiSettings = loadSettings();
let planInfo: PlanInfo | null = null;
const pending: { file: File; handle?: FileSystemFileHandle }[] = [];

// ---------- run state (the job being converted)
interface RunState {
    job: JobSpec;
    opts: RunOptions;
    output: OutputTarget;
    opfsName: string | null;
    plan: PlanInfo | null;
    resolve: (o: Outcome) => void;
}
let run: RunState | null = null;
let worker: Worker | null = null;
let running = false;
let logLines: string[] = [];
let lastBeat = 0;
let startedAt = 0;
let tick: number | undefined;
let wakeLock: { release(): Promise<void> } | null = null;
let currentStage: Stage = 'header';
let currentDetail = '';
let lastProgress: { overall: number; label: string; eta?: number; written?: number } = { overall: 0, label: '' };
let gpuNote = '';
let lastSingle: JobSpec | null = null;
let preparing = false;   // building a job: waiting for the preview sample
let starting = false;    // a single run between its click and its worker (save dialog, preview)
const reportedErrors = new Set<string>();

const hasSavePicker = () => typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

/** Busy converting, or about to (a single run is past its click): the queue must not start now. */
export const isRunning = () => running || starting;
export const editorFile = () => file;
export const getProgress = () => lastProgress;
export const runningJobId = () => run?.job.id ?? null;

const log = (line: string) => {
    const ts = new Date().toISOString().substring(11, 19);
    logLines.push(`${ts} ${line}`);
    if (logLines.length > 2000) logLines = logLines.slice(-1500);
    const pre = $('p-log');
    pre.textContent = logLines.slice(-400).join('\n');
    pre.scrollTop = pre.scrollHeight;
};

// ---------- crash marker: survives a tab that dies (e.g. out of memory)
const markRun = (stage: Stage, detail: string) => {
    try {
        localStorage.setItem(RUN_KEY, JSON.stringify({
            at: Date.now(), startedAt, stage, detail, splats: run?.job.input.vertexCount, fileBytes: run?.job.file.size,
            settings: settingsForReport(), release: getRelease(), progress: lastProgress.overall, mode: run?.opts.mode
        }));
    } catch { /* ignore */ }
};
const clearRun = () => {
    try {
        localStorage.removeItem(RUN_KEY);
    } catch { /* ignore */ }
};

const settingsForReport = () => {
    const s = run?.job.settings ?? settings;
    return { ...s, memoryGb: Math.round(s.memoryBytes / 1024 ** 3) };
};

export const checkCrash = async () => {
    let raw: string | null = null;
    try {
        raw = localStorage.getItem(RUN_KEY);
    } catch { /* ignore */ }
    if (!raw) return;
    clearRun();
    try {
        const r = JSON.parse(raw);
        const ago = fmtDuration((Date.now() - r.at) / 1000);
        const box = $('crash');
        box.textContent = t('ui.crash', { stage: stageName(r.stage), ago });
        box.hidden = false;
        if (autoReportAllowed()) {
            await submitError({
                message: `Previous run ended unexpectedly (tab closed or crashed) at stage "${r.stage}": ${r.detail}`,
                stage: `crash-${r.stage}`,
                extra: { progress: { previousRun: r } }
            });
        }
    } catch { /* ignore */ }
};

const stageName = (s: string) => {
    const k = `ui.stage.${s}`;
    const v = t(k);
    return v === k ? s : v;
};

// ---------- compatibility
const showCompat = () => {
    const notes: string[] = [];
    if (isMobile()) notes.push(t('ui.compat.mobile'));
    if (!('gpu' in navigator)) notes.push(t('ui.compat.noGpu'));
    if (!hasSavePicker()) notes.push(t('ui.compat.noSave'));
    const box = $('compat');
    if (notes.length) {
        box.innerHTML = '';
        for (const n of notes) {
            const p = document.createElement('p');
            p.textContent = n;
            box.appendChild(p);
        }
        box.hidden = false;
    }
};

// ---------- file selection (several files can be picked: the first opens, the rest wait for review)
const takeFiles = (list: { file: File; handle?: FileSystemFileHandle }[]) => {
    const plys = list.filter(x => /\.ply$/i.test(x.file.name));
    if (plys.length < list.length) showFileWarn(t('ui.unsupportedPick'));
    const fresh = plys.filter(x => !hooks.claimFile(x.file, x.handle));
    if (!fresh.length) return;
    if (!file) {
        const [first, ...rest] = fresh;
        pending.push(...rest);
        useFile(first.file, first.handle);
    } else {
        pending.push(...fresh);
        renderPending();
    }
};

const pickFile = async () => {
    const w = window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> };
    if (w.showOpenFilePicker) {
        try {
            const hs = await w.showOpenFilePicker({ types: [{ description: 'PLY', accept: { 'application/octet-stream': ['.ply'] } }], multiple: true });
            takeFiles(await Promise.all(hs.map(async h => ({ file: await h.getFile(), handle: h }))));
            return;
        } catch (e) {
            if ((e as Error).name === 'AbortError') return;
        }
    }
    $<HTMLInputElement>('file-input').click();
};

export const pickFiles = () => pickFile();

const renderPending = () => {
    const el = $('fi-pending');
    if (!pending.length) {
        el.hidden = true;
        return;
    }
    el.textContent = t('queue.pending', { n: pending.length, names: pending.slice(0, 4).map(p => p.file.name).join(', ') + (pending.length > 4 ? ', …' : '') });
    el.hidden = false;
};

const useFile = async (f: File, handle?: FileSystemFileHandle, preset?: { settings: UiSettings }) => {
    if (!/\.ply$/i.test(f.name)) {
        showFileWarn(t('ui.unsupportedPick'));
        return;
    }
    file = f;
    fileHandle = handle;
    header = null;
    if (preset) {
        settings = { ...preset.settings, rotation: [0, 0, 0], translation: [0, 0, 0] };
        writeForm(settings);
        syncPreset();
    }
    $('fi-name').textContent = f.name;
    $('file-info').hidden = false;
    $('drop').hidden = true;
    $('fi-facts').innerHTML = `<div><dt>${t('ui.facts.size')}</dt><dd>${fmtBytes(f.size)}</dd></div><div><dt>…</dt><dd>${t('ui.reading')}</dd></div>`;
    $('fi-levels').innerHTML = '';
    hideFileWarn();
    renderPending();
    try {
        const head = new Uint8Array(await f.slice(0, Math.min(f.size, 256 * 1024)).arrayBuffer());
        header = parsePlyHeader(head);
        const need = header.bodyOffset + header.vertexCount * header.stride;
        if (f.size < need) throw new Error(`The file is ${fmtInt(f.size)} bytes but its header needs ${fmtInt(need)}: it is truncated.`);
        track('file_selected', sizeBucket(f.size), { splats: header.vertexCount, sh: header.shBands });
        renderPlan();
        loadOrientation(f, header);
    } catch (e) {
        header = null;
        showFileWarn((e as Error).message);
    }
    updateButtons();
    hooks.onEditorChange();
};

const showFileWarn = (text: string) => {
    const w = $('fi-warn');
    w.textContent = text;
    w.hidden = false;
    if (!file) {
        $('file-info').hidden = false;
        $('drop').hidden = false;
    }
};
const hideFileWarn = () => {
    $('fi-warn').hidden = true;
};

const renderPlan = () => {
    if (!file || !header) return;
    const gpu = settings.useGpu && 'gpu' in navigator;
    const p = previewPlan(header, file.size, settings, gpu);
    planInfo = p;
    const facts: [string, string][] = [
        [t('ui.facts.size'), fmtBytes(file.size)],
        [t('ui.facts.splats'), fmtInt(header.vertexCount)],
        [t('ui.facts.sh'), p.keptShBands !== header.shBands ? `${header.shBands} → ${p.keptShBands}` : String(header.shBands)],
        [t('ui.facts.estTime'), `≈ ${fmtDuration(p.estimatedSeconds)}`],
        [t('ui.facts.estOut'), `≈ ${fmtBytes(p.estimatedOutputBytes)}`],
        [t('ui.facts.tiles'), `${p.tiles} / ${p.passes}`]
    ];
    const floor = p.levels[p.levels.length - 1];
    const floorPct = Math.round((floor / VIEWER_BUDGETS.vrTarget) * 100);
    facts.push([t('ui.facts.floor'), t('ui.floorValue', { n: fmtInt(floor), p: floorPct })]);
    if (header.extraProperties.length) facts.push([t('ui.facts.dropped'), header.extraProperties.join(', ')]);
    const dl = $('fi-facts');
    dl.innerHTML = '';
    for (const [k, v] of facts) {
        const div = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        div.append(dt, dd);
        dl.appendChild(div);
    }
    const tbody = $('fi-levels');
    tbody.innerHTML = '';
    p.levels.forEach((c, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>LOD ${i}</td><td>${fmtInt(c)}</td><td>${((c / p.levels[0]) * 100).toFixed(c / p.levels[0] < 0.01 ? 2 : 1)}%</td>`;
        tbody.appendChild(tr);
    });
    const total = p.levels.reduce((a, b) => a + b, 0);
    $('fi-plan-note').textContent = p.levels.length === 1 ?
        t('ui.oneLevel', { min: fmtInt(settings.minCoarsest) }) :
        t('ui.planNote', { levels: p.levels.length, total: fmtInt(total) });
    const warns: string[] = [];
    if (p.estimatedOutputBytes > 10 * 1024 ** 3) warns.push(t('ui.over10', { size: fmtBytes(p.estimatedOutputBytes) }));
    if (floor > 0.25 * VIEWER_BUDGETS.vrTarget) warns.push(t('ui.floorWarn'));
    if (warns.length) showFileWarn(warns.join(' ')); else hideFileWarn();
};

/** Convert / Add to queue availability. Exported: the queue changes what "busy" means. */
export const updateButtons = () => {
    const ready = !!file && !!header;
    const btn = $<HTMLButtonElement>('convert');
    const why = $('convert-why');
    const busy = running || starting || hooks.queueBusy();
    btn.disabled = busy || !ready || preparing;
    $<HTMLButtonElement>('enqueue').disabled = !ready || preparing;
    why.textContent = !file ? t('ui.needFile') : preparing ? t('queue.preparing') : busy && ready ? t('queue.busy') : '';
};

/** Back to an empty editor, or on to the next picked file. */
export const nextFile = () => {
    file = null;
    fileHandle = undefined;
    header = null;
    planInfo = null;
    $('result').hidden = true;
    $('error').hidden = true;
    $<HTMLInputElement>('file-input').value = '';
    const next = pending.shift();
    if (next) {
        useFile(next.file, next.handle);
    } else {
        $('file-info').hidden = true;
        $('drop').hidden = false;
        renderPending();
        updateButtons();
        hooks.onEditorChange();
    }
    $('step-file').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/** Open a queued file in the editor again (to change its orientation or preset). */
export const editInEditor = (f: File, handle: FileSystemFileHandle | undefined, s: UiSettings, keepCurrent = true) => {
    if (file && keepCurrent) pending.unshift({ file, handle: fileHandle });
    useFile(f, handle, { settings: s });
    $('step-file').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const stemOf = (name: string) => name.replace(/\.ply$/i, '').replace(/[^\p{L}\p{N}._\-]+/gu, '_').replace(/^_+|_+$/g, '').substring(0, 80) || 'scene';
export const outputNameFor = (name: string, n = 1) => `${stemOf(name)}-SSOG${n > 1 ? `-${n}` : ''}.zip`;

/** Snapshot the editor into a job (waits for the preview: centring needs the sample). */
export const editorJob = async (): Promise<JobSpec | null> => {
    if (!file || !header || preparing) return null;
    // the editor may move on while the preview loads: build the job from what was clicked
    const f = file, h = header, fh = fileHandle;
    preparing = true;
    updateButtons();
    try {
        settings = readForm();
        saveSettings(settings);
        const base = settings;
        const orient = await orientationForConversion();
        if (file !== f) return null;
        const s: UiSettings = { ...base, rotation: orient.rotation, translation: orient.translation };
        const plan = previewPlan(h, f.size, s, s.useGpu && 'gpu' in navigator);
        return {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            file: f,
            handle: fh,
            input: { vertexCount: h.vertexCount, shBands: h.shBands, format: h.format, extraProperties: h.extraProperties, stride: h.stride },
            settings: s,
            preset: matchPreset(base),
            plan
        };
    } finally {
        preparing = false;
        updateButtons();
    }
};

// ---------- single run: one file, a save dialog
const startSingle = async (again?: JobSpec) => {
    if (running || starting || preparing || hooks.queueBusy()) return;
    if (!again && (!file || !header)) return;
    starting = true;
    updateButtons();
    try {
        await startSingleInner(again);
    } finally {
        starting = false;
        updateButtons();
        if (!running) hooks.onRunEnd();
    }
};

const startSingleInner = async (again?: JobSpec) => {
    if (!(await acquire())) {
        $('convert-why').textContent = t('queue.otherTab');
        return;
    }
    let output: OutputTarget;
    let opfsName: string | null = null;
    let name = outputNameFor((again?.file ?? file!).name);
    if (hasSavePicker()) {
        try {
            const handle = await (window as unknown as { showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
                suggestedName: name,
                types: [{ description: 'Streamed SOG (.zip)', accept: { 'application/zip': ['.zip'] } }]
            });
            output = { kind: 'fsa', handle };
        } catch (e) {
            if ((e as Error).name === 'AbortError') {
                $('convert-why').textContent = t('ui.saveCancelled');
                return;
            }
            throw e;
        }
    } else {
        // browser storage: never overwrite an earlier result (a queue result may carry the same name)
        const root = await navigator.storage.getDirectory();
        for (let n = 2; await root.getFileHandle(name).then(() => true, () => false); n++) name = outputNameFor((again?.file ?? file!).name, n);
        opfsName = name;
        output = { kind: 'opfs', name };
        track('save_fallback', 'opfs');
    }
    // after the save dialog: the dialog needs the click's user activation, waiting first could lose it
    const job = again ?? await editorJob();
    if (!job) return;
    lastSingle = job;
    const o = await runJob(job, output, { mode: 'single' }, opfsName);
    if (o.ok) showResult(job, o, opfsName);
    else if (o.cancelled) showCancelled();
    else showError(o);
};

const showCancelled = () => {
    const box = $('error');
    box.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = t('ui.cancelled');
    box.appendChild(p);
    box.hidden = false;
};

// ---------- the runner (single and queue)
export const runJob = (job: JobSpec, output: OutputTarget, opts: RunOptions, opfsName: string | null = output.kind === 'opfs' ? output.name : null): Promise<Outcome> =>
    new Promise<Outcome>((resolve) => {
        if (running) {
            // guarded by isRunning()/starting; never stop or replace the run that is going
            resolve({ ok: false, error: { name: 'Busy', message: 'Another conversion is running.' }, stage: 'header', detail: 'starting', cancelled: true, reportId: null, details: '' });
            return;
        }
        try {
            beginRun(job, output, opts, opfsName, resolve);
        } catch (e) {
            const err = e as Error;
            if (running) finishWithError({ name: err.name, message: err.message, stack: err.stack }, 'header', 'starting', false);
            else resolve({ ok: false, error: { name: err.name, message: err.message, stack: err.stack }, stage: 'header', detail: 'starting', cancelled: false, reportId: null, details: `${err.name}: ${err.message}` });
        }
    });

const beginRun = (job: JobSpec, output: OutputTarget, opts: RunOptions, opfsName: string | null, resolve: (o: Outcome) => void) => {
        run = { job, opts, output, opfsName, plan: job.plan, resolve };
        running = true;
        updateButtons();
        logLines = [];
        reportedErrors.clear();
        gpuNote = '';
        if (opts.mode === 'single') {
            // a queue run leaves the last single result (and its download link) on screen
            $('result').hidden = true;
            $('error').hidden = true;
        }
        $('crash').hidden = true;
        $('progress').hidden = false;
        $('topbar').hidden = false;
        const jobEl = $('p-job');
        jobEl.textContent = opts.jobLabel ?? '';
        jobEl.hidden = !opts.jobLabel;
        if (opts.mode === 'single') $('progress').scrollIntoView({ behavior: 'smooth', block: 'center' });
        renderStages(null);
        setProgress({ overall: 0, label: t('ui.reading') });
        startedAt = Date.now();
        lastBeat = Date.now();
        markRun('header', 'starting');
        tick = window.setInterval(updateClock, 1000);
        holdWake();

        const s = job.settings;
        track('convert_start', sizeBucket(job.file.size), { splats: job.input.vertexCount, levels: job.plan.levels.length, gpu: s.useGpu, mem: Math.round(s.memoryBytes / 1024 ** 3), queue: opts.mode === 'queue' });
        log(`start: ${job.file.name}, ${fmtInt(job.input.vertexCount)} splats, ${fmtBytes(job.file.size)}, settings ${JSON.stringify(settingsForReport())}`);
        log(`orientation: rotate ${s.rotation.join(', ')}°, move ${s.translation.map(v => v.toFixed(2)).join(', ')}`);

        worker = new Worker(new URL('../engine/worker-boot.ts', import.meta.url), { type: 'module', name: 'sog-converter' });
        worker.onmessage = (e: MessageEvent<FromWorker>) => onWorkerMessage(e.data);
        worker.onerror = (e: ErrorEvent) => {
            e.preventDefault();
            finishWithError({ name: 'WorkerError', message: e.message || 'The converter stopped unexpectedly (often: out of memory).' }, currentStage, currentDetail, false);
        };
        const { useGpu, workers, ...conv } = s;
        const msg: StartMessage = { type: 'start', file: job.file, output, settings: conv, useGpu: useGpu && 'gpu' in navigator, workers };
        worker.postMessage(msg);
};

const warnUnload = (e: BeforeUnloadEvent) => {
    if (running || hooks.queueBusy()) {
        e.preventDefault();
        e.returnValue = '';
    }
};

// ---------- keep the computer awake while working (a screen wake lock is dropped whenever the
// page is hidden, so take it again when it becomes visible)
type Sentinel = { release(): Promise<void>; addEventListener?(t: string, f: () => void): void };
let wakeRequest: Promise<void> | null = null;
let wakeWanted = false;
const holdWake = () => {
    wakeWanted = true;
    if (wakeLock || wakeRequest) return wakeRequest ?? Promise.resolve();
    const api = (navigator as unknown as { wakeLock?: { request(t: string): Promise<Sentinel> } }).wakeLock;
    if (!api) return Promise.resolve();
    wakeRequest = api.request('screen').then((sentinel) => {
        if (!wakeWanted) {
            // released while the request was in flight
            sentinel.release().catch(() => undefined);
            return;
        }
        wakeLock = sentinel;
        sentinel.addEventListener?.('release', () => {
            if (wakeLock === sentinel) wakeLock = null;
        });
    }).catch(() => { /* not allowed (hidden page, policy): fine */ }).finally(() => {
        wakeRequest = null;
    });
    return wakeRequest;
};
const dropWake = () => {
    wakeWanted = false;
    wakeLock?.release().catch(() => undefined);
    wakeLock = null;
};
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (running || hooks.queueBusy())) holdWake();
    if (running) log(`page ${document.visibilityState}`);
});
export const keepAwake = (on: boolean) => (on ? holdWake() : dropWake());

const onWorkerMessage = (m: FromWorker) => {
    lastBeat = Date.now();
    switch (m.type) {
        case 'heartbeat':
            break;
        case 'gpu':
            gpuNote = m.ok ? t('ui.gpuOk', { name: m.adapter ?? 'WebGPU' }) : t('ui.gpuNo', { err: m.error ?? '?' });
            log(gpuNote);
            if (!m.ok) track('gpu_unavailable', /adapter|not available/i.test(m.error ?? '') ? 'no-adapter' : 'device-error');
            break;
        case 'stage':
            currentStage = m.stage;
            currentDetail = m.detail;
            markRun(m.stage, m.detail);
            renderStages(m.stage);
            log(m.detail);
            break;
        case 'verifying':
            setProgress({ overall: 0.995 + 0.005 * m.fraction, label: t('ui.stage.verify') });
            break;
        case 'event': {
            const ev = m.ev;
            if (ev.type === 'progress') {
                setProgress({ overall: ev.overall, label: ev.label, eta: ev.etaSeconds, written: ev.bytesWritten });
            } else if (ev.type === 'log') {
                log(`${ev.level === 'info' ? '' : `${ev.level.toUpperCase()}: `}${ev.text}`);
            } else if (ev.type === 'plan') {
                if (run) run.plan = ev.plan;
                log(`plan: levels ${ev.plan.levels.map(fmtInt).join(' / ')}; ${ev.plan.tiles} tiles; ${ev.plan.passes} pass(es); tile ≤ ${fmtInt(ev.plan.tileSplats)} splats; estimate ${fmtDuration(ev.plan.estimatedSeconds)}`);
            } else if (ev.type === 'tileDone') {
                markRun(currentStage, `tile ${ev.tile + 1}/${ev.tiles} done`);
            }
            break;
        }
        case 'result':
            finishOk(m.result, m.verify, m.outputName);
            break;
        case 'error':
            finishWithError(m.error, m.stage, m.detail, m.cancelled);
            break;
    }
};

const setProgress = (p: { overall: number; label: string; eta?: number; written?: number }) => {
    lastProgress = p;
    const pct = Math.max(0, Math.min(100, p.overall * 100));
    $('p-fill').style.width = `${pct}%`;
    $('topbar-fill').style.width = `${pct}%`;
    $('progress').querySelector('.bar')!.setAttribute('aria-valuenow', pct.toFixed(0));
    $('p-pct').textContent = `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
    $('p-label').textContent = p.label;
    $('p-eta').textContent = p.eta !== undefined ? t('ui.eta', { t: fmtDuration(p.eta) }) : '';
    $('p-written').textContent = p.written ? t('ui.written', { size: fmtBytes(p.written) }) : '';
    document.title = `${run?.opts.titlePrefix ? `${run.opts.titlePrefix} · ` : ''}${pct.toFixed(0)}% · Shramko SOG LOD Converter`;
    hooks.onProgress({ overall: p.overall, eta: p.eta });
};

const updateClock = () => {
    $('p-elapsed').textContent = t('ui.elapsed', { t: fmtDuration((Date.now() - startedAt) / 1000) });
    const quiet = Math.round((Date.now() - lastBeat) / 1000);
    $('p-beat').textContent = quiet > 20 ? t('ui.beatSlow', { s: quiet }) : `● ${t('ui.beatOk')}${gpuNote ? ` · ${gpuNote}` : ''}`;
};

const STAGES: Stage[] = ['sample', 'read', 'decimate', 'encode', 'finalize', 'verify'];
const renderStages = (current: Stage | null) => {
    const ol = $('p-stages');
    const idx = current ? STAGES.indexOf(current) : -1;
    ol.innerHTML = '';
    STAGES.forEach((s, i) => {
        const li = document.createElement('li');
        li.textContent = t(`ui.stage.${s}`);
        // read/decimate/encode repeat per tile: show them as active together while tiles run
        const tileLoop = idx >= 1 && idx <= 3 && i >= 1 && i <= 3;
        li.className = i < idx && !tileLoop ? 'done' : i === idx ? 'active' : tileLoop && i < idx ? 'done' : '';
        ol.appendChild(li);
    });
};

/** Common end of a run; returns the run that ended. */
const stopRun = (): RunState | null => {
    const r = run;
    running = false;
    run = null;
    window.clearInterval(tick);
    if (!hooks.queueBusy()) dropWake();
    worker?.terminate();
    worker = null;
    clearRun();
    $('topbar').hidden = true;
    $('progress').hidden = true;
    document.title = t('meta.title');
    updateButtons();
    setTimeout(() => hooks.onRunEnd(), 0);
    return r;
};

const finishOk = (result: Omit<PipelineResult, 'meta'>, verify: VerifyReport, outputName: string) => {
    if (!running) return;
    const r = stopRun()!;
    track('convert_done', sizeBucket(r.job.file.size), { splats: r.job.input.vertexCount, levels: result.counts.length, seconds: Math.round(result.seconds), ok: verify.ok, mb: Math.round(result.archiveBytes / 1024 ** 2), queue: r.opts.mode === 'queue' });
    log(`done: ${outputName}, ${result.counts.length} levels, ${fmtBytes(result.archiveBytes)}, ${fmtDuration(result.seconds)}, check ${verify.ok ? 'ok' : 'FAILED'}`);
    if (!verify.ok) {
        // report even in queue mode; the outcome still counts as written (the file exists)
        submitErrorFor(r, { message: `Archive verification failed: ${verify.errors.slice(0, 5).join(' | ')}`, stage: 'verify', extra: { output: { verify, result } } });
    }
    r.resolve({ ok: true, result, verify, outputName });
};

const showResult = async (job: JobSpec, o: Extract<Outcome, { ok: true }>, opfsName: string | null) => {
    const { result, verify, outputName } = o;
    const box = $('result');
    box.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = verify.ok ? t('ui.doneTitle') : t('ui.verifyFail');
    box.appendChild(h);
    const p1 = document.createElement('p');
    p1.textContent = t('ui.doneFile', { name: outputName, size: fmtBytes(result.archiveBytes) });
    const p2 = document.createElement('p');
    p2.textContent = t('ui.doneLevels', { levels: result.counts.length, chunks: fmtInt(verify.units), files: fmtInt(verify.entries), time: fmtDuration(result.seconds) });
    box.append(p1, p2);
    const table = document.createElement('table');
    table.className = 'levels';
    table.innerHTML = `<thead><tr><th>${t('app.level')}</th><th>${t('app.splats')}</th></tr></thead>`;
    const tb = document.createElement('tbody');
    result.counts.forEach((c, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>LOD ${i}</td><td>${fmtInt(c)}</td>`;
        tb.appendChild(tr);
    });
    table.appendChild(tb);
    box.appendChild(table);

    const v = document.createElement('p');
    if (verify.ok) {
        v.className = 'ok';
        v.textContent = `✓ ${t('ui.verifyOk', { levels: verify.lodLevels })}`;
        box.appendChild(v);
    } else {
        const ul = document.createElement('ul');
        ul.className = 'errors';
        for (const e of verify.errors) {
            const li = document.createElement('li');
            li.textContent = e;
            ul.appendChild(li);
        }
        box.appendChild(ul);
    }
    for (const w of verify.warnings) {
        const p = document.createElement('p');
        p.className = 'warn';
        p.textContent = w;
        box.appendChild(p);
    }

    if (opfsName) box.appendChild(await opfsDownloadLink(opfsName));

    const up = document.createElement('div');
    up.className = 'upload';
    up.innerHTML = `<h4>${t('ui.uploadTitle')}</h4><p>${t('ui.uploadSteps')}</p>`;
    const go = document.createElement('a');
    go.className = 'btn primary';
    go.href = 'https://superspl.at/';
    go.target = '_blank';
    go.rel = 'noopener';
    go.textContent = t('ui.uploadBtn');
    up.appendChild(go);
    box.appendChild(up);

    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn ghost';
    again.textContent = t('ui.again');
    again.addEventListener('click', () => {
        if (file === job.file) nextFile();
        else $('step-file').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    box.appendChild(again);
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/** A download button for a result kept in browser storage (browsers without a save dialog). */
export const opfsDownloadLink = async (name: string) => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(name);
    const url = URL.createObjectURL(await fh.getFile());
    const a = document.createElement('a');
    a.className = 'btn primary';
    a.href = url;
    a.download = name;
    a.textContent = t('ui.download');
    return a;
};

export const hintFor = (msg: string, stage: string) => {
    if (/memory|allocation failed|out of memory|RangeError: Array buffer/i.test(msg) || stage.startsWith('crash')) return t('ui.errHintMemory');
    if (/GPU|WebGPU|device lost/i.test(msg)) return t('ui.errHintGpu');
    if (stage === 'header') return t('ui.errHintInput');
    return '';
};

const finishWithError = async (error: WorkerErrorInfo, stage: Stage, detail: string, cancelled: boolean) => {
    if (!running) return;
    const r = stopRun()!;
    const details = `${error.name}: ${error.message}\nfile: ${r.job.file.name}\nstage: ${stage} — ${detail}\nrelease: ${getRelease()}\n${error.stack ?? ''}\n\n${logLines.slice(-60).join('\n')}`;
    if (cancelled) {
        log(t('ui.cancelled'));
        track('convert_cancel', stage);
        if (r.opfsName) navigator.storage.getDirectory().then(d => d.removeEntry(r.opfsName!)).catch(() => undefined);
        r.resolve({ ok: false, error, stage, detail, cancelled: true, reportId: null, details });
        return;
    }
    log(`ERROR at ${stage} (${detail}): ${error.name}: ${error.message}`);
    track('convert_error', stage);
    let reportId: string | null = null;
    if (autoReportAllowed()) {
        reportId = await submitErrorFor(r, { message: `${error.name}: ${error.message}`, stage, extra: { stack: error.stack, error: { name: error.name, message: error.message, code: error.code, detail } } });
    }
    r.resolve({ ok: false, error, stage, detail, cancelled: false, reportId, details });
};

const showError = (o: Extract<Outcome, { ok: false }>) => {
    const { error, stage, detail } = o;
    const box = $('error');
    box.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = t('ui.errTitle');
    const msg = document.createElement('p');
    msg.className = 'err-msg';
    msg.textContent = error.message;
    const st = document.createElement('p');
    st.className = 'muted small';
    st.textContent = `${t('ui.errStage', { stage: stageName(stage) })} — ${detail}`;
    box.append(h, msg, st);
    const hint = hintFor(error.message, stage);
    if (hint) {
        const hp = document.createElement('p');
        hp.className = 'hint';
        hp.textContent = hint;
        box.appendChild(hp);
    }
    const rep = document.createElement('p');
    rep.className = 'muted small report-line';
    box.appendChild(rep);
    const row = document.createElement('div');
    row.className = 'p-row';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn ghost small';
    copy.textContent = t('ui.errCopy');
    copy.addEventListener('click', () => navigator.clipboard.writeText(o.details).then(() => {
        copy.textContent = t('ui.copied');
    }));
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn primary small';
    retry.textContent = t('ui.errRetry');
    retry.addEventListener('click', () => {
        box.hidden = true;
        startSingle(lastSingle ?? undefined).catch(onStartError);
    });
    row.append(retry, copy);
    if (o.reportId) {
        rep.textContent = t('ui.errReported', { id: o.reportId });
    } else if (autoReportAllowed()) {
        rep.textContent = t('ui.errReportFail');
    } else {
        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'btn ghost small';
        send.textContent = t('ui.errSend');
        send.addEventListener('click', async () => {
            send.disabled = true;
            const id = await submitError({ message: `${error.name}: ${error.message}`, stage, extra: { stack: error.stack, error: { name: error.name, message: error.message, code: error.code, detail } } });
            rep.textContent = id ? t('ui.errReported', { id }) : t('ui.errReportFail');
        });
        row.appendChild(send);
    }
    box.appendChild(row);
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const autoReportAllowed = () => $<HTMLInputElement>('auto-report').checked;

/** Report about a run that has just ended (its job is no longer the current run). */
const submitErrorFor = (r: RunState, e: { message: string; stage: string; extra?: Record<string, unknown> }) =>
    submitError(e, { job: r.job, plan: r.plan, mode: r.opts.mode });

/** Send an anonymous error report; returns its id or null. Deduplicated per run. */
export const submitError = async (
    e: { message: string; stage: string; extra?: Record<string, unknown> },
    ctx: { job: JobSpec; plan: PlanInfo | null; mode: string } | null = run ? { job: run.job, plan: run.plan, mode: run.opts.mode } : null
): Promise<string | null> => {
    const key = `${e.stage}|${e.message}`.substring(0, 300);
    if (reportedErrors.has(key) || reportedErrors.size >= 3) return null;
    reportedErrors.add(key);
    const input = ctx ? { ...ctx.job.input, bytes: ctx.job.file.size } :
        header ? { splats: header.vertexCount, shBands: header.shBands, bytes: file?.size, format: header.format, extraProperties: header.extraProperties, stride: header.stride } : null;
    const s = ctx?.job.settings ?? settings;
    try {
        const r = await sendReport({
            kind: 'error',
            message: `[${e.stage}] ${e.message}`.substring(0, 2000),
            locale: lang,
            page: 'convert',
            release: getRelease(),
            stage: e.stage,
            diagnosticsConsent: true,
            diagnostics: {
                browser: browserInfo(),
                gpu: await gpuInfo(),
                options: { settings: { ...s, memoryGb: Math.round(s.memoryBytes / 1024 ** 3) }, plan: ctx?.plan ?? planInfo, mode: ctx?.mode ?? 'single' },
                input,
                progress: { ...lastProgress, stage: currentStage, detail: currentDetail },
                timings: { elapsedSec: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null },
                errors: recentErrors(),
                log: logLines.slice(-150),
                ...e.extra
            },
            website: '',
            t: 999999
        });
        return r.id ?? null;
    } catch (err) {
        console.warn('error report failed', describe(err));
        return null;
    }
};

/** Cancel the running job (single or queue). */
export const cancelRun = () => {
    if (!running || !worker) return;
    $('p-label').textContent = t('ui.cancelling');
    worker.postMessage({ type: 'cancel' });
    // a busy worker may not see the message for a while; stop it hard after a grace period
    const w = worker;
    setTimeout(() => {
        if (running && worker === w) finishWithError({ name: 'AbortError', message: 'Cancelled' }, currentStage, currentDetail, true);
    }, 4000);
};

const onStartError = (e: unknown) => {
    const err = e as Error;
    showError({ ok: false, error: { name: err.name, message: err.message, stack: err.stack }, stage: 'header', detail: 'starting', cancelled: false, reportId: null, details: `${err.name}: ${err.message}\n${err.stack ?? ''}` });
};

let syncPreset = () => undefined as void;

export const initConverter = () => {
    showCompat();
    initOrientationPanel();
    writeForm(settings);
    try {
        const pref = localStorage.getItem(REPORT_PREF);
        if (pref !== null) $<HTMLInputElement>('auto-report').checked = pref === '1';
    } catch { /* ignore */ }
    $<HTMLInputElement>('auto-report').addEventListener('change', (e) => {
        try {
            localStorage.setItem(REPORT_PREF, (e.target as HTMLInputElement).checked ? '1' : '0');
        } catch { /* ignore */ }
    });

    const drop = $('drop');
    $('pick').addEventListener('click', (e) => {
        e.stopPropagation();
        pickFile();
    });
    drop.addEventListener('click', () => pickFile());
    drop.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pickFile();
        }
    });
    drop.addEventListener('dragover', (e) => {
        e.preventDefault();
        drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.remove('over');
        onDropFiles(e.dataTransfer);
    });
    // files can also be dropped on the file card while one is open (they wait for review)
    const card = $('step-file');
    card.addEventListener('dragover', (e) => {
        if (!$('file-info').hidden) e.preventDefault();
    });
    card.addEventListener('drop', (e) => {
        if (e.defaultPrevented || $('file-info').hidden) return;
        e.preventDefault();
        onDropFiles(e.dataTransfer);
    });
    $<HTMLInputElement>('file-input').addEventListener('change', (e) => {
        const fl = (e.target as HTMLInputElement).files;
        if (fl?.length) takeFiles(Array.from(fl).map(f => ({ file: f })));
        (e.target as HTMLInputElement).value = '';
    });
    $('fi-change').addEventListener('click', nextFile);

    syncPreset = () => {
        const id = matchPreset(settings);
        document.querySelectorAll<HTMLInputElement>('input[name=preset]').forEach((r) => {
            r.checked = r.value === id;
        });
        $('preset-custom').hidden = id !== 'custom';
    };
    document.querySelectorAll<HTMLInputElement>('input[name=preset]').forEach((r) => {
        r.addEventListener('change', () => {
            if (!r.checked) return;
            settings = { ...readForm(), ...PRESETS[r.value as PresetId] };
            writeForm(settings);
            saveSettings(settings);
            syncPreset();
            renderPlan();
            track('preset', r.value);
        });
    });
    const onSettings = () => {
        settings = readForm();
        saveSettings(settings);
        syncPreset();
        renderPlan();
    };
    $('advanced').addEventListener('change', onSettings);
    $('s-reset').addEventListener('click', () => {
        settings = defaults();
        writeForm(settings);
        saveSettings(settings);
        syncPreset();
        renderPlan();
    });
    syncPreset();

    $('convert').addEventListener('click', () => {
        startSingle().catch(onStartError);
    });
    $('cancel').addEventListener('click', cancelRun);
    $('copy-log').addEventListener('click', () => navigator.clipboard.writeText(logLines.join('\n')));
    addEventListener('beforeunload', warnUnload);
    updateButtons();
};

/** Dropped files, with their handles when the browser gives them (needed to resume after a reload). */
const onDropFiles = (dt: DataTransfer | null) => {
    if (!dt) return;
    const items = Array.from(dt.items ?? []).filter(i => i.kind === 'file');
    // getAsFileSystemHandle must be called synchronously inside the drop event
    const handlePromises = items.map(i => (i as unknown as { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.() ?? Promise.resolve(null));
    const files = Array.from(dt.files ?? []);
    Promise.all(handlePromises.map(p => p.catch(() => null))).then((handles) => {
        takeFiles(files.map((f, i) => {
            const h = handles[i];
            return { file: f, handle: h && h.kind === 'file' ? h as FileSystemFileHandle : undefined };
        }));
    });
};
