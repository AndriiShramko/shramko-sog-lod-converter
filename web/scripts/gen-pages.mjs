// Generates one fully translated, crawlable HTML page per language from web/template.html and
// web/src/i18n/<lang>.json (missing keys fall back to English). Vite then builds each as an entry.
//
//   node web/scripts/gen-pages.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['en', 'es', 'pl', 'ru'];
const template = readFileSync(join(web, 'template.html'), 'utf8');
const en = JSON.parse(readFileSync(join(web, 'src/i18n/en.json'), 'utf8'));

// keys whose values are trusted HTML (lists, emphasis); everything else is escaped
const HTML_KEYS = new Set(['status.worksList', 'status.progressList', 'status.nextList', 'limits.list']);
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = s => s.replace(/<[^>]+>/g, '');

let missingTotal = 0;
for (const lang of LANGS) {
    const dict = lang === 'en' ? en : { ...en, ...JSON.parse(readFileSync(join(web, `src/i18n/${lang}.json`), 'utf8')) };
    if (lang !== 'en') {
        const own = JSON.parse(readFileSync(join(web, `src/i18n/${lang}.json`), 'utf8'));
        const missing = Object.keys(en).filter(k => !(k in own));
        if (missing.length) {
            missingTotal += missing.length;
            console.warn(`[${lang}] ${missing.length} keys missing (English used): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`);
        }
    }

    const faq = [];
    for (let i = 1; i <= 9; i++) faq.push({ '@type': 'Question', name: dict[`faq.q${i}`], acceptedAnswer: { '@type': 'Answer', text: dict[`faq.a${i}`] } });
    const jsonld = [
        {
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: 'Shramko SOG LOD Converter',
            alternateName: 'PLY to Streamed SOG LOD converter',
            url: `https://sog.flyreelstudio.eu/${lang}/`,
            applicationCategory: 'MultimediaApplication',
            operatingSystem: 'Any (desktop browser with WebGPU recommended)',
            browserRequirements: 'Chrome or Edge with WebGPU; File System Access API for saving straight to disk',
            description: dict['meta.description'],
            inLanguage: lang,
            isAccessibleForFree: true,
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
            license: 'https://opensource.org/licenses/MIT',
            codeRepository: 'https://github.com/AndriiShramko/shramko-sog-lod-converter',
            author: {
                '@type': 'Person',
                name: 'Andrii Shramko',
                url: 'https://www.linkedin.com/in/andrii-shramko/',
                sameAs: ['https://github.com/AndriiShramko', 'https://www.linkedin.com/in/andrii-shramko/']
            }
        },
        { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq },
        {
            '@context': 'https://schema.org',
            '@type': 'HowTo',
            name: dict['how.title'],
            step: [1, 2, 3, 4].map(i => ({ '@type': 'HowToStep', name: dict[`how.s${i}t`], text: dict[`how.s${i}`] }))
        }
    ];

    const html = template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_m, key) => {
        if (key === 'lang') return lang;
        if (key === 'jsonld') return JSON.stringify(jsonld).replace(/</g, '\\u003c');
        const v = dict[key];
        if (v === undefined) throw new Error(`template key "${key}" has no English text`);
        return HTML_KEYS.has(key) ? v : esc(v);
    });
    if (/\{\{/.test(html)) throw new Error(`unreplaced placeholder in ${lang}`);
    mkdirSync(join(web, lang), { recursive: true });
    // pages live one level down, so make the shared asset paths absolute
    writeFileSync(join(web, lang, 'index.html'), html);
    console.log(`wrote web/${lang}/index.html (${(html.length / 1024).toFixed(0)} KB, title: ${strip(dict['meta.title'])})`);
}

// root page: nginx redirects "/" by cookie / Accept-Language; this is the fallback (no inline JS: CSP)
writeFileSync(join(web, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shramko SOG LOD Converter</title><meta http-equiv="refresh" content="0; url=/en/"><link rel="canonical" href="https://sog.flyreelstudio.eu/en/">
<link rel="alternate" hreflang="en" href="https://sog.flyreelstudio.eu/en/"><link rel="alternate" hreflang="es" href="https://sog.flyreelstudio.eu/es/">
<link rel="alternate" hreflang="pl" href="https://sog.flyreelstudio.eu/pl/"><link rel="alternate" hreflang="ru" href="https://sog.flyreelstudio.eu/ru/">
</head><body><p><a href="/en/">English</a> · <a href="/es/">Español</a> · <a href="/pl/">Polski</a> · <a href="/ru/">Русский</a></p></body></html>
`);
if (missingTotal) console.warn(`${missingTotal} translations missing in total`);
