// Settings form ⇄ ConvertSettings, persisted in localStorage so a refresh keeps them.

import { DEFAULT_SETTINGS, type ConvertSettings } from '../engine/plan';

export interface UiSettings extends ConvertSettings {
    useGpu: boolean;
    workers: number;
}

const KEY = 'sog_settings_v1';
const GB = 1024 ** 3;

/** RAM default: browsers cap a tab near 16 GB; deviceMemory reports at most 8 (privacy cap). */
export const defaultMemoryGb = () => {
    const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    if (!dm) return 6;
    if (dm >= 8) return 8;
    return Math.max(2, Math.floor(dm * 0.5));
};

export const defaults = (): UiSettings => ({
    ...DEFAULT_SETTINGS,
    memoryBytes: defaultMemoryGb() * GB,
    useGpu: true,
    workers: 0
});

export const loadSettings = (): UiSettings => {
    try {
        const raw = localStorage.getItem(KEY);
        if (raw) return { ...defaults(), ...JSON.parse(raw) };
    } catch { /* private mode or bad JSON */ }
    return defaults();
};

export const saveSettings = (s: UiSettings) => {
    try {
        localStorage.setItem(KEY, JSON.stringify(s));
    } catch { /* ignore */ }
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string, def: number, min: number, max: number) => {
    const v = parseFloat($<HTMLInputElement>(id).value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
};

/** Put settings into the form. */
export const writeForm = (s: UiSettings) => {
    $<HTMLInputElement>('s-ratio').value = String(s.lodRatio);
    $<HTMLInputElement>('s-min').value = String(s.minCoarsest);
    $<HTMLInputElement>('s-maxlevels').value = String(s.maxLevels);
    $<HTMLSelectElement>('s-decimator').value = s.decimator;
    $<HTMLSelectElement>('s-sh').value = String(s.shBands);
    $<HTMLInputElement>('s-iter').value = String(s.iterations);
    $<HTMLSelectElement>('s-webp').value = s.webpEffort === null ? '' : String(s.webpEffort);
    $<HTMLInputElement>('s-nan').checked = s.filterNaN;
    $<HTMLInputElement>('s-ccount').value = String(s.chunkCount);
    $<HTMLInputElement>('s-cextent').value = String(s.chunkExtent);
    $<HTMLInputElement>('s-cmin').value = String(s.chunkMin);
    $<HTMLInputElement>('s-mem').value = String(Math.round(s.memoryBytes / GB));
    $<HTMLInputElement>('s-tile').value = String(s.tileSplats);
    $<HTMLInputElement>('s-gpu').checked = s.useGpu;
    $<HTMLInputElement>('s-workers').value = String(s.workers);
};

/** Read and clamp the form (any input is turned into a valid setting). */
export const readForm = (): UiSettings => {
    const d = defaults();
    const webp = $<HTMLSelectElement>('s-webp').value;
    return {
        lodRatio: num('s-ratio', d.lodRatio, 0.1, 0.9),
        minCoarsest: Math.round(num('s-min', d.minCoarsest, 1000, 1e9)),
        maxLevels: Math.round(num('s-maxlevels', 0, 0, 16)),
        decimator: $<HTMLSelectElement>('s-decimator').value === 'adaptive' ? 'adaptive' : 'uniform',
        filterNaN: $<HTMLInputElement>('s-nan').checked,
        shBands: parseInt($<HTMLSelectElement>('s-sh').value, 10) as UiSettings['shBands'],
        iterations: Math.round(num('s-iter', d.iterations, 1, 100)),
        webpEffort: webp === '' ? null : Math.min(9, Math.max(0, parseInt(webp, 10))),
        chunkCount: Math.round(num('s-ccount', d.chunkCount, 16, 4096)),
        chunkExtent: num('s-cextent', d.chunkExtent, 1, 1000),
        chunkMin: Math.round(num('s-cmin', d.chunkMin, 1, 512)),
        memoryBytes: Math.round(num('s-mem', d.memoryBytes / GB, 2, 15)) * GB,
        tileSplats: Math.round(num('s-tile', 0, 0, 60_000_000)),
        useGpu: $<HTMLInputElement>('s-gpu').checked,
        workers: Math.round(num('s-workers', 0, 0, 16)),
        // per-file orientation lives in the preview panel (orient-panel.ts), not in global settings
        rotation: [0, 0, 0],
        translation: [0, 0, 0]
    };
};
