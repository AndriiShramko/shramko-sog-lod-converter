// After `vite build`: write dist/release.json with a content hash of the build, so the page,
// error reports and the deploy script all name the same release.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = process.env.SOG_OUT ? join(process.cwd(), process.env.SOG_OUT) : fileURLToPath(new URL('../../dist/', import.meta.url));
const files = [];
const walk = (d) => {
    for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (!p.endsWith('.map') && !p.endsWith('release.json')) files.push(p);
    }
};
walk(dist);
files.sort();

// GA4 guard: every language page must load exactly the committed measurement id (web/src/ga-id.json).
// A build without it would ship a site with no analytics and no banner, silently (Drony Bydgoszcz lost
// 8 days of GA that way). The id sits in the page's entry script or in a chunk the page preloads.
const { gaId } = JSON.parse(readFileSync(fileURLToPath(new URL('../src/ga-id.json', import.meta.url)), 'utf8'));
if (!/^G-[A-Z0-9]{6,12}$/.test(gaId ?? '')) {
    console.error(`GA guard: web/src/ga-id.json has no valid gaId (${gaId})`);
    process.exit(1);
}
for (const lang of ['en', 'es', 'pl', 'ru']) {
    const html = readFileSync(join(dist, lang, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="modulepreload"[^>]*\shref)="\/?([^"]+\.js)"/g)].map(m => m[1]);
    const code = refs.map(r => readFileSync(join(dist, r), 'utf8')).join('\n');
    const foreign = [...new Set(code.match(/\bG-[A-Z0-9]{10}\b/g) ?? [])].filter(id => id !== gaId);
    if (!code.includes(gaId) || foreign.length) {
        console.error(`GA guard: ${lang}/index.html scripts (${refs.join(', ') || 'none'}) ${code.includes(gaId) ? `also carry ${foreign.join(', ')}` : `lack ${gaId}`}`);
        process.exit(1);
    }
}
console.log(`GA guard: ${gaId} in every language page`);
const h = createHash('sha256');
for (const f of files) {
    h.update(relative(dist, f).split('\\').join('/'));
    h.update(readFileSync(f));
}
const sha = h.digest('hex').substring(0, 12);
writeFileSync(join(dist, 'release.json'), `${JSON.stringify({ sha, built: new Date().toISOString() })}\n`);
console.log(`release ${sha} (${files.length} files)`);
