import { installErrorCapture, loadRelease } from './ui/diagnostics';
// capture errors before anything else runs
installErrorCapture();

import './styles.css';
import { initAnalytics, gaEvent, where } from './ui/analytics';
import { track } from './ui/api';
import { initConverter } from './ui/converter';
import { initFeedback } from './ui/feedback';
import { initQueue } from './ui/queue';
import { rememberLang, t } from './ui/i18n';

const initLangSwitch = () => {
    document.querySelectorAll<HTMLAnchorElement>('a[data-lang]').forEach((a) => {
        if (a.dataset.lang === document.documentElement.lang) a.setAttribute('aria-current', 'true');
        a.addEventListener('click', () => {
            rememberLang(a.dataset.lang!);
            track('lang_switch', a.dataset.lang!, { cta_location: where(a) });
        });
    });
};

const initCopyButtons = () => {
    document.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((b) => {
        b.addEventListener('click', () => {
            const text = document.getElementById(b.dataset.copy!)?.textContent ?? '';
            navigator.clipboard.writeText(text).then(() => {
                gaEvent('copy_prompt', { cta_location: where(b) });
                const old = b.textContent;
                b.textContent = t('ui.copied');
                setTimeout(() => {
                    b.textContent = old;
                }, 1500);
            });
        });
    });
};

const logBuffer: string[] = [];

const main = async () => {
    initAnalytics(); // first: the banner must work even if a later init throws
    initLangSwitch();
    initCopyButtons();
    initConverter();
    initQueue();
    initFeedback(() => Array.from(document.getElementById('p-log')?.textContent?.split('\n') ?? logBuffer));
    const rel = await loadRelease();
    const el = document.getElementById('release');
    if (el) el.textContent = `release ${rel}`;
    // the server counter's page_view; GA's comes from gtag('config') (ui/analytics.ts), never from here
    track('page_view', document.documentElement.lang);
};

main();
