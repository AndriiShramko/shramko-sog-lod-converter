// Screenshots of a built site (desktop + phone) for review and the README.
//   node tools/shots.mjs <distDir> <outDir> [--base http://localhost:5190]
// With --base, shoots a live URL instead of serving <distDir>.

import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const [distArg, outDir] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const baseArg = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : '';
const dist = resolve(distArg ?? 'dist');
mkdirSync(outDir, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
let server = null;
let base = baseArg;
if (!base) {
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname.startsWith('/api/')) { res.writeHead(204); return res.end(); }
        let p = join(dist, decodeURIComponent(url.pathname));
        if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
        if (!existsSync(p)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
        createReadStream(p).pipe(res);
    }).listen(5190);
    base = 'http://localhost:5190';
}

const browser = await chromium.launch({ channel: 'chrome' });
const shots = [
    { name: 'desktop-en-top', lang: 'en', vp: { width: 1366, height: 900 } },
    { name: 'desktop-en-contact', lang: 'en', vp: { width: 1366, height: 900 }, anchor: '#contact' },
    { name: 'desktop-ru-top', lang: 'ru', vp: { width: 1366, height: 900 } },
    { name: 'mobile-en-top', lang: 'en', vp: { width: 375, height: 812 }, mobile: true },
    { name: 'mobile-pl-contact', lang: 'pl', vp: { width: 375, height: 812 }, mobile: true, anchor: '#contact' },
    { name: 'og-source', lang: 'en', vp: { width: 1200, height: 630 } }
];
const problems = [];
for (const s of shots) {
    const ctx = await browser.newContext({ viewport: s.vp, deviceScaleFactor: s.mobile ? 2 : 1, isMobile: !!s.mobile, hasTouch: !!s.mobile });
    const page = await ctx.newPage();
    page.on('pageerror', e => problems.push(`${s.name}: pageerror ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') problems.push(`${s.name}: console ${m.text().substring(0, 200)}`); });
    await page.goto(`${base}/${s.lang}/`, { waitUntil: 'networkidle' });
    if (s.anchor) await page.locator(s.anchor).scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    // horizontal overflow check (mobile layout bugs)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) problems.push(`${s.name}: horizontal overflow ${overflow}px`);
    await page.screenshot({ path: join(outDir, `${s.name}.png`) });
    await ctx.close();
}
await browser.close();
server?.close();
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no page errors, no horizontal overflow');
