// The converter panel: pick a file, preview the plan, run the worker, show progress,
// the result or the error — and report errors so they can be fixed.

import { parsePlyHeader, type PlyHeader } from '../engine/ply-header';
import { previewPlan, type PlanInfo, type Stage } from '../engine/plan';
import type { PipelineResult } from '../engine/pipeline';
import type { FromWorker, OutputTarget, StartMessage } from '../engine/protocol';
import type { VerifyReport } from '../engine/verify';
import { sendReport, sizeBucket, track } from './api';
import { browserInfo, describe, getRelease, gpuInfo, recentErrors } from './diagnostics';
import { fmtBytes, fmtDuration, fmtInt, lang, t } from './i18n';
import { loadSettings, readForm, saveSettings, writeForm, defaults, type UiSettings } from './settings';
import { PRESETS, VIEWER_BUDGETS, matchPreset, type PresetId } from '../engine/presets';
import { initOrientationPanel, loadOrientation, orientationForConversion } from './orient-panel';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const RUN_KEY = 'sog_run_v1';
const REPORT_PREF = 'sog_auto_report';

let file: File | null = null;
let header: PlyHeader | null = null;
let settings: UiSettings = loadSettings();
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
let opfsName: string | null = null;
let gpuNote = '';
let planInfo: PlanInfo | null = null;
const reportedErrors = new Set<string>();

const hasSavePicker = () => typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

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
            at: Date.now(), startedAt, stage, detail, splats: header?.vertexCount, fileBytes: file?.size,
            settings: settingsForReport(), release: getRelease(), progress: lastProgress.overall
        }));
    } catch { /* ignore */ }
};
const clearRun = () => {
    try {
        localStorage.removeItem(RUN_KEY);
    } catch { /* ignore */ }
};

const settingsForReport = () => ({ ...settings, memoryGb: Math.round(settings.memoryBytes / 1024 ** 3) });

const checkCrash = async () => {
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

// ---------- file selection
const pickFile = async () => {
    const w = window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> };
    if (w.showOpenFilePicker) {
        try {
            const [h] = await w.showOpenFilePicker({ types: [{ description: 'PLY', accept: { 'application/octet-stream': ['.ply'] } }], multiple: false });
            if (h) await useFile(await h.getFile());
            return;
        } catch (e) {
            if ((e as Error).name === 'AbortError') return;
        }
    }
    $<HTMLInputElement>('file-input').click();
};

const useFile = async (f: File) => {
    if (running) return;
    if (!/\.ply$/i.test(f.name)) {
        showFileWarn(t('ui.unsupportedPick'));
        return;
    }
    file = f;
    header = null;
    $('fi-name').textContent = f.name;
    $('file-info').hidden = false;
    $('drop').hidden = true;
    $('fi-facts').innerHTML = `<div><dt>${t('ui.facts.size')}</dt><dd>${fmtBytes(f.size)}</dd></div><div><dt>…</dt><dd>${t('ui.reading')}</dd></div>`;
    $('fi-levels').innerHTML = '';
    hideFileWarn();
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
    updateConvertButton();
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

const updateConvertButton = () => {
    const btn = $<HTMLButtonElement>('convert');
    const why = $('convert-why');
    btn.disabled = running || !file || !header;
    why.textContent = !file ? t('ui.needFile') : '';
};

// ---------- run
const suggestedName = () => {
    const base = (file?.name ?? 'scene.ply').replace(/\.ply$/i, '').replace(/[^\w.\-]+/g, '_').substring(0, 80) || 'scene';
    return `${base}-SSOG.zip`;
};

const start = async () => {
    if (!file || !header || running) return;
    settings = readForm();
    saveSettings(settings);

    let output: OutputTarget;
    opfsName = null;
    if (hasSavePicker()) {
        try {
            const handle = await (window as unknown as { showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
                suggestedName: suggestedName(),
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
        opfsName = suggestedName();
        output = { kind: 'opfs', name: opfsName };
        track('save_fallback', 'opfs');
    }

    // after the save dialog: the dialog needs the click's user activation, waiting first could lose it
    const orient = await orientationForConversion();
    running = true;
    updateConvertButton();
    logLines = [];
    reportedErrors.clear();
    gpuNote = '';
    $('result').hidden = true;
    $('error').hidden = true;
    $('crash').hidden = true;
    $('progress').hidden = false;
    $('topbar').hidden = false;
    $('progress').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('fi-change').setAttribute('disabled', '');
    renderStages(null);
    setProgress({ overall: 0, label: t('ui.reading') });
    startedAt = Date.now();
    lastBeat = Date.now();
    markRun('header', 'starting');
    tick = window.setInterval(updateClock, 1000);
    addEventListener('beforeunload', warnUnload);
    try {
        wakeLock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null;
    } catch { /* not allowed: fine */ }

    track('convert_start', sizeBucket(file.size), { splats: header.vertexCount, levels: planInfo?.levels.length ?? 0, gpu: settings.useGpu, mem: Math.round(settings.memoryBytes / 1024 ** 3) });
    log(`start: ${fmtInt(header.vertexCount)} splats, ${fmtBytes(file.size)}, settings ${JSON.stringify(settingsForReport())}`);

    worker = new Worker(new URL('../engine/worker-boot.ts', import.meta.url), { type: 'module', name: 'sog-converter' });
    worker.onmessage = (e: MessageEvent<FromWorker>) => onWorkerMessage(e.data);
    worker.onerror = (e: ErrorEvent) => {
        e.preventDefault();
        finishWithError({ name: 'WorkerError', message: e.message || 'The converter stopped unexpectedly (often: out of memory).' }, currentStage, currentDetail, false);
    };
    const { useGpu, workers, ...conv } = settings;
    const msg: StartMessage = { type: 'start', file, output, settings: { ...conv, rotation: orient.rotation, translation: orient.translation }, useGpu: useGpu && 'gpu' in navigator, workers };
    log(`orientation: rotate ${orient.rotation.join(', ')}°, move ${orient.translation.join(', ')}`);
    worker.postMessage(msg);
};

const warnUnload = (e: BeforeUnloadEvent) => {
    if (running) {
        e.preventDefault();
        e.returnValue = '';
    }
};

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
                planInfo = ev.plan;
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
    if (p.eta !== undefined) $('p-eta').textContent = t('ui.eta', { t: fmtDuration(p.eta) });
    if (p.written) $('p-written').textContent = t('ui.written', { size: fmtBytes(p.written) });
    document.title = `${pct.toFixed(0)}% · Shramko SOG LOD Converter`;
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

const stopRun = () => {
    running = false;
    window.clearInterval(tick);
    removeEventListener('beforeunload', warnUnload);
    wakeLock?.release().catch(() => undefined);
    wakeLock = null;
    worker?.terminate();
    worker = null;
    clearRun();
    $('topbar').hidden = true;
    $('fi-change').removeAttribute('disabled');
    document.title = t('meta.title');
    updateConvertButton();
};

const finishOk = async (result: Omit<PipelineResult, 'meta'>, verify: VerifyReport, outputName: string) => {
    stopRun();
    $('progress').hidden = true;
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
        submitError({ message: `Archive verification failed: ${verify.errors.slice(0, 5).join(' | ')}`, stage: 'verify', extra: { output: { verify, result } } });
    }
    for (const w of verify.warnings) {
        const p = document.createElement('p');
        p.className = 'warn';
        p.textContent = w;
        box.appendChild(p);
    }

    if (opfsName) {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(opfsName);
        const url = URL.createObjectURL(await fh.getFile());
        const a = document.createElement('a');
        a.className = 'btn primary';
        a.href = url;
        a.download = opfsName;
        a.textContent = t('ui.download');
        box.appendChild(a);
    }

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
    again.addEventListener('click', resetFile);
    box.appendChild(again);
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    track('convert_done', sizeBucket(file?.size ?? 0), { splats: header?.vertexCount ?? 0, levels: result.counts.length, seconds: Math.round(result.seconds), ok: verify.ok, mb: Math.round(result.archiveBytes / 1024 ** 2) });
};

const hintFor = (msg: string, stage: string) => {
    if (/memory|allocation failed|out of memory|RangeError: Array buffer/i.test(msg) || stage.startsWith('crash')) return t('ui.errHintMemory');
    if (/GPU|WebGPU|device lost/i.test(msg)) return t('ui.errHintGpu');
    if (stage === 'header') return t('ui.errHintInput');
    return '';
};

const finishWithError = async (error: { name: string; message: string; stack?: string; code?: string }, stage: Stage, detail: string, cancelled: boolean) => {
    if (!running) return;
    stopRun();
    $('progress').hidden = true;
    if (cancelled) {
        log(t('ui.cancelled'));
        const box = $('error');
        box.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = t('ui.cancelled');
        box.appendChild(p);
        box.hidden = false;
        track('convert_cancel', stage);
        if (opfsName) navigator.storage.getDirectory().then(r => r.removeEntry(opfsName!)).catch(() => undefined);
        return;
    }
    log(`ERROR at ${stage} (${detail}): ${error.name}: ${error.message}`);
    track('convert_error', stage);
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
    const details = `${error.name}: ${error.message}\nstage: ${stage} — ${detail}\nrelease: ${getRelease()}\n${error.stack ?? ''}\n\n${logLines.slice(-60).join('\n')}`;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn ghost small';
    copy.textContent = t('ui.errCopy');
    copy.addEventListener('click', () => navigator.clipboard.writeText(details).then(() => {
        copy.textContent = t('ui.copied');
    }));
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn primary small';
    retry.textContent = t('ui.errRetry');
    retry.addEventListener('click', () => {
        box.hidden = true;
        start();
    });
    row.append(retry, copy);
    const payload = { message: `${error.name}: ${error.message}`, stage, extra: { stack: error.stack, error: { name: error.name, message: error.message, code: error.code, detail } } };
    if (autoReportAllowed()) {
        rep.textContent = '…';
        const id = await submitError(payload);
        rep.textContent = id ? t('ui.errReported', { id }) : t('ui.errReportFail');
    } else {
        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'btn ghost small';
        send.textContent = t('ui.errSend');
        send.addEventListener('click', async () => {
            send.disabled = true;
            const id = await submitError(payload);
            rep.textContent = id ? t('ui.errReported', { id }) : t('ui.errReportFail');
        });
        row.appendChild(send);
    }
    box.appendChild(row);
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const autoReportAllowed = () => $<HTMLInputElement>('auto-report').checked;

/** Send an anonymous error report; returns its id or null. Deduplicated per session. */
export const submitError = async (e: { message: string; stage: string; extra?: Record<string, unknown> }): Promise<string | null> => {
    const key = `${e.stage}|${e.message}`.substring(0, 300);
    if (reportedErrors.has(key) || reportedErrors.size >= 3) return null;
    reportedErrors.add(key);
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
                options: { settings: settingsForReport(), plan: planInfo },
                input: header ? { splats: header.vertexCount, shBands: header.shBands, bytes: file?.size, format: header.format, extraProperties: header.extraProperties, stride: header.stride } : null,
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

const resetFile = () => {
    if (running) return;
    file = null;
    header = null;
    planInfo = null;
    $('file-info').hidden = true;
    $('drop').hidden = false;
    $('result').hidden = true;
    $('error').hidden = true;
    $<HTMLInputElement>('file-input').value = '';
    updateConvertButton();
    $('drop').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

const cancel = () => {
    if (!running || !worker) return;
    $('p-label').textContent = t('ui.cancelling');
    worker.postMessage({ type: 'cancel' });
    // a busy worker may not see the message for a while; stop it hard after a grace period
    const w = worker;
    setTimeout(() => {
        if (running && worker === w) finishWithError({ name: 'AbortError', message: 'Cancelled' }, currentStage, currentDetail, true);
    }, 4000);
};

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
        drop.classList.remove('over');
        const f = e.dataTransfer?.files?.[0];
        if (f) useFile(f);
    });
    $<HTMLInputElement>('file-input').addEventListener('change', (e) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (f) useFile(f);
    });
    $('fi-change').addEventListener('click', resetFile);

    const syncPreset = () => {
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
        start().catch(e => finishWithError({ name: (e as Error).name, message: (e as Error).message, stack: (e as Error).stack }, 'header', 'starting', false));
    });
    $('cancel').addEventListener('click', cancel);
    $('copy-log').addEventListener('click', () => navigator.clipboard.writeText(logLines.join('\n')));
    updateConvertButton();
    checkCrash();
};
