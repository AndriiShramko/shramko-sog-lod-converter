import { installErrorCapture, loadRelease } from './ui/diagnostics';
// capture errors before anything else runs
installErrorCapture();

import './styles.css';
import { gaAvailable, loadGa, track } from './ui/api';
import { initConverter } from './ui/converter';
import { initFeedback } from './ui/feedback';
import { initQueue } from './ui/queue';
import { rememberLang, t } from './ui/i18n';

const CONSENT_KEY = 'sog_consent';

const initLangSwitch = () => {
    document.querySelectorAll<HTMLAnchorElement>('a[data-lang]').forEach((a) => {
        if (a.dataset.lang === document.documentElement.lang) a.setAttribute('aria-current', 'true');
        a.addEventListener('click', () => {
            rememberLang(a.dataset.lang!);
            track('lang_switch', a.dataset.lang!);
        });
    });
};

const initCopyButtons = () => {
    document.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((b) => {
        b.addEventListener('click', () => {
            const text = document.getElementById(b.dataset.copy!)?.textContent ?? '';
            navigator.clipboard.writeText(text).then(() => {
                const old = b.textContent;
                b.textContent = t('ui.copied');
                setTimeout(() => {
                    b.textContent = old;
                }, 1500);
            });
        });
    });
};

const initConsent = () => {
    if (!gaAvailable()) return;
    let choice: string | null = null;
    try {
        choice = localStorage.getItem(CONSENT_KEY);
    } catch { /* ignore */ }
    if (choice === 'yes') return loadGa();
    if (choice === 'no') return;
    const bar = document.getElementById('consent')!;
    bar.hidden = false;
    const set = (v: string) => {
        try {
            localStorage.setItem(CONSENT_KEY, v);
        } catch { /* ignore */ }
        bar.hidden = true;
        if (v === 'yes') loadGa();
    };
    document.getElementById('consent-yes')!.addEventListener('click', () => set('yes'));
    document.getElementById('consent-no')!.addEventListener('click', () => set('no'));
};

const logBuffer: string[] = [];

const main = async () => {
    initLangSwitch();
    initCopyButtons();
    initConverter();
    initQueue();
    initFeedback(() => Array.from(document.getElementById('p-log')?.textContent?.split('\n') ?? logBuffer));
    initConsent();
    const rel = await loadRelease();
    const el = document.getElementById('release');
    if (el) el.textContent = `release ${rel}`;
    track('page_view', document.documentElement.lang);
};

main();
