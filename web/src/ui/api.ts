// Same-origin calls to the site's tiny API (feedback, error reports, leads, cookieless counters).

import { gaEvent, type GaParams } from './analytics';

export type ReportKind = 'bug' | 'idea' | 'error';
export type ReportPage = 'site' | 'convert';

export interface ReportBody {
    kind: ReportKind;
    message: string;
    contact?: string;
    locale: string;
    page: ReportPage;
    release: string;
    stage?: string;
    diagnosticsConsent: boolean;
    diagnostics?: Record<string, unknown>;
    website?: string; // honeypot
    t: number;        // ms since the form opened
}

const gzip = async (text: string): Promise<Uint8Array | null> => {
    if (typeof CompressionStream === 'undefined') return null;
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** POST JSON; bodies over 8 KB are gzipped. Returns the parsed JSON or throws. */
const post = async (path: string, body: unknown): Promise<any> => {
    const text = JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let payload: BodyInit = text;
    if (text.length > 8192) {
        const z = await gzip(text);
        if (z) {
            payload = z as unknown as BodyInit;
            headers['Content-Encoding'] = 'gzip';
        }
    }
    const r = await fetch(path, { method: 'POST', headers, body: payload, credentials: 'omit', keepalive: text.length < 60000 });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`HTTP ${r.status}${json?.error ? `: ${json.error}` : ''}`);
    return json;
};

export const sendReport = (body: ReportBody): Promise<{ ok: boolean; id: string; delivered?: boolean }> => post('/api/report', body);

export const sendLead = (body: { role: string; email: string; message: string; consent: boolean; locale: string; page: string; website: string; t: number }) => post('/api/lead', body);

/** Input-size bucket the counter API accepts. */
export const sizeBucket = (bytes: number) => {
    const g = bytes / 1024 ** 3;
    if (bytes < 100 * 1024 ** 2) return 'lt100m';
    if (g < 1) return '100m-1g';
    if (g < 4) return '1g-4g';
    if (g < 16) return '4g-16g';
    if (g < 64) return '16g-64g';
    return 'gt64g';
};

// The counter's one coarse value -> the GA4 parameter it goes to (never GA's numeric `value`).
const GA_PARAM: Record<string, string> = {
    lang_switch: 'lang_to',
    file_selected: 'size_bucket',
    convert_start: 'size_bucket',
    convert_done: 'size_bucket',
    convert_error: 'stage',
    convert_cancel: 'stage',
    gpu_unavailable: 'reason',
    preset: 'preset',
    save_fallback: 'method',
    queue_add: 'count',
    queue_start: 'count',
    queue_done: 'count'
};
// counted on our server only: GA's page_view comes from gtag('config') alone (one per page load),
// and a lead goes to GA as generate_lead {form_id, lead_type} (feedback.ts)
const COUNTER_ONLY = new Set(['page_view', 'lead_submit']);
// a navigation follows at once: GA must use sendBeacon
const BEACON = new Set(['lang_switch']);

/**
 * Cookieless first-party counter (`{e, p}`: event name + one coarse value from the API's list), and the
 * same event in Google Analytics (only after consent) with `p` under its own parameter name plus
 * `props`. Never throws.
 */
export const track = (name: string, p?: string, props?: GaParams) => {
    try {
        const body = JSON.stringify(p ? { e: name, p } : { e: name });
        if (navigator.sendBeacon) {
            navigator.sendBeacon('/api/e', new Blob([body], { type: 'application/json' }));
        } else {
            fetch('/api/e', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => undefined);
        }
    } catch { /* counters must never break the page */ }
    if (COUNTER_ONLY.has(name)) return;
    const param = GA_PARAM[name];
    const value = param === 'count' && p !== undefined ? Number(p) : p;
    gaEvent(name, { ...(param && p !== undefined ? { [param]: value } : {}), ...props }, BEACON.has(name));
};
