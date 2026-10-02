// The "Preview & orientation" panel: sample the picked file, show it as SuperSplat will, let the
// user turn it, and hand the chosen rotation (+ optional centring) to the conversion.
// Orientation is per FILE (scans differ between people and tools) — remembered by name + size.

import type { PlyHeader } from '../engine/ply-header';
import { t } from './i18n';
import { autoOrient, centreTranslation, turnWorld, type Vec3T } from './orientation';
import { PreviewView } from './preview';
import { samplePreview, type PreviewSample } from './preview-sample';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

let view: PreviewView | null = null;
let sample: PreviewSample | null = null;
let samplePromise: Promise<PreviewSample | null> | null = null;
let euler: Vec3T = [0, 0, 0];
let fileKey = '';

const storeKey = () => `sog_orient_${fileKey}`;
const save = () => {
    try {
        localStorage.setItem(storeKey(), JSON.stringify({ euler, centre: $<HTMLInputElement>('o-centre').checked }));
    } catch { /* private mode */ }
};

const showAngles = () => {
    $<HTMLInputElement>('o-x').value = String(euler[0]);
    $<HTMLInputElement>('o-y').value = String(euler[1]);
    $<HTMLInputElement>('o-z').value = String(euler[2]);
};

const apply = (next: Vec3T, msg = '', ok = false) => {
    euler = next;
    showAngles();
    save();
    const m = $('o-msg');
    m.textContent = msg;
    m.className = `small o-msg${ok ? ' ok' : ''}`;
    if (view && sample) view.setTransform(euler, currentTranslation());
};

const currentTranslation = (): Vec3T => (sample && $<HTMLInputElement>('o-centre').checked ? centreTranslation(sample.raw, sample.count, euler) : [0, 0, 0]);

/** Called when a new file has been picked and its header parsed. */
export const loadOrientation = async (file: File, header: PlyHeader) => {
    fileKey = `${file.name}_${file.size}`;
    sample = null;
    euler = [0, 0, 0];
    let stored: { euler?: Vec3T; centre?: boolean } | null = null;
    try {
        stored = JSON.parse(localStorage.getItem(storeKey()) ?? 'null');
    } catch { /* ignore */ }
    if (stored?.euler) euler = stored.euler;
    $<HTMLInputElement>('o-centre').checked = stored?.centre ?? true;
    showAngles();
    $('o-msg').textContent = '';
    const status = $('pv-status');
    status.textContent = t('orient.loading');
    try {
        view ??= new PreviewView($<HTMLCanvasElement>('pv-canvas'));
    } catch {
        status.textContent = t('orient.noWebgl');
    }
    const target = isMobile() ? 150_000 : 400_000;
    samplePromise = samplePreview(file, header, target, (f) => {
        status.textContent = `${t('orient.loading')} ${Math.round(f * 100)}%`;
    }).then((s) => {
        sample = s;
        if (view) {
            view.setSample(s);
            view.setTransform(euler, currentTranslation());
        }
        status.textContent = t('orient.shown', { n: s.count.toLocaleString(), total: s.total.toLocaleString() });
        // first time this file is seen: suggest an orientation
        if (!stored?.euler) runAuto();
        return s;
    }).catch((e: Error) => {
        status.textContent = `${t('orient.failed')} ${e.message}`;
        return null;
    });
    await samplePromise;
};

const runAuto = () => {
    if (!sample) return;
    const a = autoOrient(sample.raw, sample.count);
    apply(a.euler, a.confident ? t('orient.autoSure', { axis: a.upAxis }) : t('orient.autoUnsure', { axis: a.upAxis }), a.confident);
};

/** Orientation for the conversion (waits for the preview sample, needed for centring). */
export const orientationForConversion = async (): Promise<{ rotation: Vec3T; translation: Vec3T }> => {
    if (samplePromise) await samplePromise;
    return { rotation: euler, translation: currentTranslation() };
};

export const initOrientationPanel = () => {
    $('o-auto').addEventListener('click', runAuto);
    $('o-flip').addEventListener('click', () => apply(turnWorld(euler, 0, 180), t('orient.flipped'), true));
    $('o-reset').addEventListener('click', () => apply([0, 0, 0]));
    document.querySelectorAll<HTMLButtonElement>('button[data-turn]').forEach((b) => {
        b.addEventListener('click', () => {
            const [axis, deg] = b.dataset.turn!.split(',').map(Number);
            apply(turnWorld(euler, axis as 0 | 1 | 2, deg));
        });
    });
    for (const id of ['o-x', 'o-y', 'o-z']) {
        $(id).addEventListener('change', () => {
            const v = (k: string) => {
                const n = parseFloat($<HTMLInputElement>(k).value);
                return Number.isFinite(n) ? Math.max(-180, Math.min(180, n)) : 0;
            };
            apply([v('o-x'), v('o-y'), v('o-z')]);
        });
    }
    $('o-centre').addEventListener('change', () => apply(euler));
    document.querySelectorAll<HTMLButtonElement>('.pv-views button[data-view]').forEach((b) => {
        b.addEventListener('click', () => view?.view(b.dataset.view as 'side' | 'top'));
    });
};
