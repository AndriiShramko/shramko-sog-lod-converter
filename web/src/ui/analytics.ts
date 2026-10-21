// Google Analytics 4, by WEB-TECH-BASELINE §T6 (Consent Mode basic, never advanced):
// - nothing is requested from Google until the visitor clicks Accept; gtag.js is loaded only then;
// - gtag('config') then sends the one page_view of the page (granted, gcs G1x1). No other code sends
//   page_view, so a reload with a stored "yes" counts exactly one;
// - withdraw: "Cookie settings" in the footer of every page opens the banner again, and Decline denies
//   analytics storage, disables the tag (window['ga-disable-<id>']), deletes this site's _ga cookies
//   (host and parent domains) and stores the choice. No reload: a conversion may be running.
// Every parameter is low-cardinality and free of personal data (no file names, no e-mails, no text
// people typed). The id lives in web/src/ga-id.json; the build and deploy refuse pages without it.

import gaConfig from '../ga-id.json';

export const GA_ID: string = gaConfig.gaId;
const CONSENT_KEY = 'sog_consent'; // 'yes' | 'no' (tools/*.mjs set it too)
const COOKIE_DAYS = 400;           // Chrome's cap; within the property's 14-month data retention

type Gtag = (...args: unknown[]) => void;
type Win = Window & Record<string, unknown> & { dataLayer?: unknown[]; gtag?: Gtag };
const w = window as unknown as Win;

// gtag.js only recognises commands pushed as an `arguments` object (an array is ignored),
// so this must be a classic function, not an arrow function with rest parameters.
const gtag: Gtag = function gtagShim() {
    w.dataLayer = w.dataLayer || [];
    // eslint-disable-next-line prefer-rest-params
    w.dataLayer.push(arguments);
};

let loaded = false;  // gtag.js requested in this page
let granted = false; // consent given and not withdrawn
let deciding = false; // the banner was opened again from "Cookie settings": record nothing until a choice

let rescanSections: (() => void) | null = null; // section_view of what is already on screen at Accept

const siteLang = () => (document.documentElement.lang || 'und').slice(0, 5).toLowerCase();
const recording = () => granted && !deciding;

export type GaParams = Record<string, string | number | boolean | undefined>;

/** A GA4 event, only while consent is granted. `beacon`: a navigation follows at once. Never throws. */
export const gaEvent = (name: string, params: GaParams = {}, beacon = false) => {
    if (!recording()) return;
    try {
        const p: GaParams = { site_lang: siteLang() };
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p[k] = v;
        if (beacon) p.transport_type = 'beacon';
        gtag('event', name, p);
    } catch { /* analytics must never break the page */ }
};

const stored = (): string | null => {
    try {
        return localStorage.getItem(CONSENT_KEY);
    } catch {
        return null;
    }
};
const store = (v: 'yes' | 'no') => {
    try {
        localStorage.setItem(CONSENT_KEY, v);
    } catch { /* private mode: the choice lasts for this page */ }
};

const grant = () => {
    granted = true;
    w[`ga-disable-${GA_ID}`] = false;
    if (loaded) {
        gtag('consent', 'update', { analytics_storage: 'granted' });
        rescanSections?.();
        return;
    }
    loaded = true;
    w.gtag = gtag;
    gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted' });
    gtag('js', new Date());
    gtag('set', { allow_google_signals: false, allow_ad_personalization_signals: false });
    gtag('config', GA_ID, { cookie_domain: location.hostname, cookie_expires: COOKIE_DAYS * 86400, site_lang: siteLang() });
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
    document.head.appendChild(s);
    rescanSections?.();
};

/** Delete this property's cookies on the host and every parent domain (not the public suffix). */
const deleteGaCookies = (withClientId: boolean) => {
    const names = [`_ga_${GA_ID.replace(/^G-/, '')}`];
    if (withClientId) names.push('_ga');
    const labels = location.hostname.split('.');
    const domains: (string | null)[] = [null];
    for (let i = 0; i < labels.length - 1; i++) domains.push(labels.slice(i).join('.'));
    for (const n of names) {
        for (const d of domains) {
            document.cookie = `${n}=; Max-Age=0; path=/${d ? `; domain=.${d}` : ''}; SameSite=Lax`;
        }
    }
};

const deny = (withdraw: boolean) => {
    const wasGranted = granted;
    granted = false;
    if (loaded) {
        w[`ga-disable-${GA_ID}`] = true;
        gtag('consent', 'update', { analytics_storage: 'denied' });
    }
    deleteGaCookies(withdraw || wasGranted);
};

export const consentGranted = () => granted;

/** Where on the page an element sits: data-cta-loc, the section id, or header/footer/dialog. */
export const where = (el: Element): string => {
    const tagged = el.closest('[data-cta-loc]');
    if (tagged) return tagged.getAttribute('data-cta-loc')!;
    const s = el.closest('section[id], header, footer, dialog[id]');
    if (!s) return 'page';
    if (s.tagName === 'DIALOG') return s.id;
    return s.id || s.tagName.toLowerCase();
};

const CONTACT: [RegExp, string][] = [
    [/^mailto:/i, 'email'],
    [/^tel:/i, 'phone'],
    [/wa\.me|api\.whatsapp\.com/i, 'whatsapp'],
    [/t\.me\//i, 'telegram'],
    [/m\.me\/|messenger\.com/i, 'messenger']
];

const initClicks = () => {
    document.addEventListener('click', (e) => {
        const el = (e.target as Element | null)?.closest?.('a, button, [data-cta]');
        if (!el || el.closest('#consent')) return;
        const href = el.getAttribute('href') ?? '';
        const loc = where(el);
        for (const [re, method] of CONTACT) {
            if (re.test(href)) return gaEvent('contact_click', { method, cta_location: loc });
        }
        if (el.tagName === 'A' && el.hasAttribute('download')) {
            const ext = (el.getAttribute('download') || '').split('.').pop()?.toLowerCase().slice(0, 8) || 'file';
            return gaEvent('file_download_click', { file_ext: ext, cta_location: loc });
        }
        const id = el.getAttribute('data-cta');
        if (id) gaEvent('cta_click', { cta_id: id, cta_location: loc });
    }, true);
};

/** section_view once per section: half of it visible, or (tall sections) half of the screen filled by it. */
const initSections = () => {
    if (!('IntersectionObserver' in window)) return;
    const seen = new Set<string>();
    const io = new IntersectionObserver((entries) => {
        if (!recording()) return; // not seen yet: Accept re-checks what is on screen (rescanSections)
        for (const en of entries) {
            if (!en.isIntersecting) continue;
            const id = (en.target as HTMLElement).id;
            const screen = en.rootBounds?.height ?? innerHeight;
            if (!id || seen.has(id)) continue;
            if (en.intersectionRatio < 0.5 && en.intersectionRect.height < screen * 0.5) continue;
            seen.add(id);
            io.unobserve(en.target);
            gaEvent('section_view', { section_id: id.slice(0, 40) });
        }
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    const targets = Array.from(document.querySelectorAll<HTMLElement>('main section[id]'));
    targets.forEach(s => io.observe(s));
    // observe() again reports the current state of each section once
    rescanSections = () => targets.filter(s => !seen.has(s.id)).forEach((s) => {
        io.unobserve(s);
        io.observe(s);
    });
};

/** exception for the site's own script errors: error name + a scrubbed message, at most 100 chars, 5 a page. */
const initExceptions = () => {
    let sent = 0;
    const scrub = (s: string) => s
        .replace(/(blob:)?https?:\/\/\S+/g, '<url>')
        .replace(/(["'`«“]).*?(["'`»”])/g, '…')
        .replace(/\s+/g, ' ')
        .trim();
    const send = (name: string, message: string) => {
        if (sent >= 5 || /ResizeObserver loop/i.test(message)) return;
        sent++;
        gaEvent('exception', { description: scrub(`${name}: ${message}`).slice(0, 100), fatal: false });
    };
    addEventListener('error', (e) => {
        if (!e.filename || !e.filename.startsWith(location.origin)) return; // not our script ("Script error." has none)
        const err = e.error as Error | undefined;
        send(err?.name || 'Error', err?.message || e.message || 'error');
    });
    addEventListener('unhandledrejection', (e) => {
        const r = e.reason as Error | undefined;
        send(r?.name || 'Rejection', r instanceof Error ? r.message : String(r ?? ''));
    });
};

/** Banner, footer "Cookie settings", and the delegated listeners. Call once at start-up. */
export const initAnalytics = () => {
    const bar = document.getElementById('consent');
    const yes = document.getElementById('consent-yes');
    const no = document.getElementById('consent-no');
    const open = document.getElementById('consent-open');
    if (!GA_ID || !bar || !yes || !no) return;
    const choice = stored();
    if (choice === 'yes') grant();
    else if (choice !== 'no') bar.hidden = false;
    yes.addEventListener('click', () => {
        deciding = false;
        store('yes');
        bar.hidden = true;
        grant();
    });
    no.addEventListener('click', () => {
        const withdraw = stored() === 'yes' || granted;
        deciding = false;
        store('no');
        bar.hidden = true;
        deny(withdraw);
    });
    open?.addEventListener('click', () => {
        deciding = true;
        bar.hidden = false;
        (stored() === 'yes' ? no : yes).focus();
    });
    initClicks();
    initSections();
    initExceptions();
};

/** Coarse duration bucket for conversions (minutes to hours). */
export const durationBucket = (seconds: number) => {
    if (seconds < 60) return 'lt1m';
    if (seconds < 300) return '1m-5m';
    if (seconds < 1800) return '5m-30m';
    if (seconds < 7200) return '30m-2h';
    return 'gt2h';
};
