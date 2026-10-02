import en from '../i18n/en.json';
import es from '../i18n/es.json';
import pl from '../i18n/pl.json';
import ru from '../i18n/ru.json';

export const LANGS = ['en', 'es', 'pl', 'ru'] as const;
export type Lang = typeof LANGS[number];

const all: Record<Lang, Record<string, string>> = { en, es, pl, ru } as Record<Lang, Record<string, string>>;

export const lang: Lang = (LANGS as readonly string[]).includes(document.documentElement.lang) ? document.documentElement.lang as Lang : 'en';

/** Translate `key`, substituting {name} placeholders. Falls back to English. */
export const t = (key: string, vars: Record<string, string | number> = {}): string => {
    const s = all[lang][key] ?? all.en[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
};

export const locale = { en: 'en-US', es: 'es-ES', pl: 'pl-PL', ru: 'ru-RU' }[lang];

export const fmtInt = (n: number) => n.toLocaleString(locale);

export const fmtBytes = (n: number) => {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    // 1024-based, like Windows Explorer and superspl.at's 10 GB limit
    while (n >= 1024 && i < u.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toLocaleString(locale, { maximumFractionDigits: n < 10 && i > 0 ? 2 : 1 })} ${u[i]}`;
};

export const fmtDuration = (sec: number) => {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h} h ${m.toString().padStart(2, '0')} min`;
    if (m > 0) return `${m} min ${r.toString().padStart(2, '0')} s`;
    return `${r} s`;
};

export const listFormat = (items: string[]) => {
    try {
        return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
    } catch {
        return items.join(', ');
    }
};

/** Remember an explicit language choice (nginx reads the cookie at "/"). */
export const rememberLang = (l: string) => {
    document.cookie = `sog_lang=${l}; path=/; max-age=31536000; samesite=lax; secure`;
    try {
        localStorage.setItem('sog_lang', l);
    } catch { /* private mode */ }
};
