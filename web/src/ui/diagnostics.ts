// Error capture from the first line of the app, plus the facts a report needs.
// Nothing here ever holds file names or file contents.

const ERRORS_KEPT = 20;
const errors: string[] = [];

const clean = (s: string) => s.replace(/(https?:\/\/[^\s?#'")]+)[?#][^\s'")]*/g, '$1').substring(0, 400);

export const describe = (x: unknown): string => {
    if (x instanceof Error) {
        const at = (x.stack ?? '').split('\n').slice(1, 3).map(l => l.trim()).join(' ');
        return clean(`${x.name}: ${x.message}${at ? ` @ ${at}` : ''}`);
    }
    try {
        return clean(typeof x === 'string' ? x : JSON.stringify(x));
    } catch {
        return clean(String(x));
    }
};

export const keepError = (kind: string, text: string) => {
    errors.push(`${new Date().toISOString().substring(11, 19)} ${kind}: ${clean(text)}`);
    if (errors.length > ERRORS_KEPT) errors.shift();
};

export const recentErrors = () => errors.slice();

export const installErrorCapture = () => {
    addEventListener('error', e => keepError('error', e.error ? describe(e.error) : `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
    addEventListener('unhandledrejection', e => keepError('rejection', describe(e.reason)));
    const consoleError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
        keepError('console', args.map(describe).join(' '));
        consoleError(...args);
    };
};

let release = 'dev';
export const loadRelease = async () => {
    try {
        const r = await fetch('/release.json', { cache: 'no-store' });
        if (r.ok) release = ((await r.json()) as { sha?: string }).sha ?? 'dev';
    } catch { /* offline or dev */ }
    return release;
};
export const getRelease = () => release;

let gpuInfoCache: Record<string, unknown> | null = null;
export const gpuInfo = async (): Promise<Record<string, unknown>> => {
    if (gpuInfoCache) return gpuInfoCache;
    const out: Record<string, unknown> = { webgpu: 'gpu' in navigator && !!navigator.gpu };
    try {
        const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
        if (a) {
            out.vendor = a.info?.vendor;
            out.architecture = a.info?.architecture;
            out.device = a.info?.device;
            out.description = a.info?.description;
            out.maxBufferSize = a.limits.maxBufferSize;
            out.maxStorageBufferBindingSize = a.limits.maxStorageBufferBindingSize;
        } else {
            out.adapter = null;
        }
    } catch (e) {
        out.error = describe(e);
    }
    gpuInfoCache = out;
    return out;
};

/** Browser facts for reports (no identifiers). */
export const browserInfo = () => ({
    userAgent: navigator.userAgent,
    platform: (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
    languages: navigator.languages?.slice(0, 4),
    cores: navigator.hardwareConcurrency,
    deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    fsa: typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function',
    opfs: !!navigator.storage?.getDirectory
});
