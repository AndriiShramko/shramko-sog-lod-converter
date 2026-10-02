// End-to-end run of the real site in real Chrome (Playwright), on a real PLY.
//
//   node tools/e2e.mjs <input.ply> <out.zip> [--mem 12] [--tile 0] [--gpu 1] [--api http://127.0.0.1:8090] [--shots dir] [--profile dir]
//
// Serves dist/ (with /api/* proxied to a local API server or stubbed), opens /en/, picks the file
// through the page's own <input>, clicks Convert, follows the progress until the result or the
// error, then downloads the archive and leaves it at <out.zip> for independent checks.
// The native save dialog cannot be driven by automation, so showSaveFilePicker is replaced by a
// handle into the browser's private storage (OPFS) — the worker writes through the same
// FileSystemFileHandle.createWritable() path a picked file uses.

import http from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const [input, outZip] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!input || !outZip) { console.error('usage: e2e.mjs <input.ply> <out.zip> [...]'); process.exit(2); }
const mem = parseFloat(opt('--mem', '8'));
const tile = parseInt(opt('--tile', '0'), 10);
const gpu = opt('--gpu', '1') !== '0';
const api = opt('--api', '');
const shots = opt('--shots', '');
const profile = opt('--profile', '.e2e-profile');
const logFile = opt('--log', '');
const dist = resolve('dist');
const PORT = parseInt(opt('--port', '5181'), 10);
if (shots) mkdirSync(shots, { recursive: true });

const say = (...a) => {
    const line = `${new Date().toISOString().substring(11, 19)} ${a.join(' ')}`;
    console.log(line);
    if (logFile) appendFileSync(logFile, `${line}\n`);
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain', '.xml': 'application/xml' };
const stubReports = [];
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/__save' && req.method === 'PUT') {
        // test-only: the page streams the finished archive here (Chrome reads it from disk)
        const out = createWriteStream(outZip);
        req.pipe(out);
        out.on('finish', () => { res.writeHead(200); res.end('saved'); });
        out.on('error', () => { res.writeHead(500); res.end(); });
        return;
    }
    if (url.pathname.startsWith('/api/')) {
        if (api) {
            const p = http.request(`${api}${url.pathname}${url.search}`, { method: req.method, headers: { ...req.headers, host: undefined, 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' } }, (pr) => {
                res.writeHead(pr.statusCode, pr.headers);
                pr.pipe(res);
            });
            p.on('error', () => { res.writeHead(502); res.end(); });
            req.pipe(p);
            return;
        }
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            if (url.pathname === '/api/report') stubReports.push(body.substring(0, 2000));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, id: 'R-STUB-0001' }));
        });
        return;
    }
    let p = join(dist, decodeURIComponent(url.pathname));
    if (url.pathname === '/') { res.writeHead(302, { location: '/en/' }); return res.end(); }
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!existsSync(p)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(p).pipe(res);
}).listen(PORT);

const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
});
await ctx.addInitScript(() => {
    // automation cannot click native file dialogs: use the page's <input> to pick, OPFS to save
    delete window.showOpenFilePicker;
    window.showSaveFilePicker = async (o) => {
        const root = await navigator.storage.getDirectory();
        return root.getFileHandle(o?.suggestedName ?? 'out.zip', { create: true });
    };
});
const page = ctx.pages()[0] ?? await ctx.newPage();
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') say(`[console.${m.type()}]`, m.text().substring(0, 300)); });
page.on('pageerror', e => say('[pageerror]', e.message));
page.on('crash', () => say('[CRASH] the page crashed'));

await page.goto(`http://localhost:${PORT}/en/`);
// settings
await page.click('#advanced summary');
await page.fill('#s-mem', String(mem));
await page.fill('#s-tile', String(tile));
await page.setChecked('#s-gpu', gpu);
await page.locator('#s-mem').dispatchEvent('change');
await page.setInputFiles('#file-input', input);
await page.waitForFunction(() => document.querySelectorAll('#fi-levels tr').length > 0 || !document.getElementById('fi-warn').hidden, null, { timeout: 60000 });
say('plan:', (await page.locator('#fi-facts').innerText()).replace(/\s+/g, ' '));
say('levels:', (await page.locator('#fi-levels').innerText()).replace(/\s+/g, ' '));
if (shots) await page.screenshot({ path: join(shots, '01-plan.png'), fullPage: false });

const t0 = Date.now();
await page.click('#convert');
let lastLabel = '';
let n = 0;
for (;;) {
    await page.waitForTimeout(5000);
    const st = await page.evaluate(() => ({
        pct: document.getElementById('p-pct')?.textContent,
        label: document.getElementById('p-label')?.textContent,
        eta: document.getElementById('p-eta')?.textContent,
        written: document.getElementById('p-written')?.textContent,
        beat: document.getElementById('p-beat')?.textContent,
        done: !document.getElementById('result').hidden,
        failed: !document.getElementById('error').hidden
    })).catch(e => ({ crashed: String(e) }));
    if (st.crashed) { say('page gone:', st.crashed); break; }
    const line = `${st.pct} | ${st.label} | ${st.eta ?? ''} | ${st.written ?? ''} | ${st.beat ?? ''}`;
    if (line !== lastLabel || n % 12 === 0) say(line);
    lastLabel = line;
    n++;
    if (shots && n % 60 === 1) await page.screenshot({ path: join(shots, `02-progress-${String(n).padStart(4, '0')}.png`) }).catch(() => {});
    if (st.done || st.failed) break;
}
const elapsed = (Date.now() - t0) / 1000;
if (shots) await page.screenshot({ path: join(shots, '03-end.png'), fullPage: false }).catch(() => {});
const resultText = await page.locator('#result').innerText().catch(() => '');
const errorText = await page.locator('#error').innerText().catch(() => '');
const log = await page.locator('#p-log').textContent().catch(() => '');
say(`finished after ${elapsed.toFixed(0)} s`);
if (resultText) say('RESULT:', resultText.replace(/\n+/g, ' | '));
if (errorText) say('ERROR:', errorText.replace(/\n+/g, ' | '));
writeFileSync(`${outZip}.log.txt`, log ?? '');
if (stubReports.length) writeFileSync(`${outZip}.reports.json`, JSON.stringify(stubReports, null, 1));

if (resultText) {
    // copy the archive out of OPFS to disk (streamed by Chrome to the local test server)
    const savedStatus = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const names = [];
        for await (const [name] of root.entries()) names.push(name);
        const name = names.find(n => n.endsWith('-SSOG.zip'));
        const f = await (await root.getFileHandle(name)).getFile();
        const r = await fetch('/__save', { method: 'PUT', body: f });
        return `${r.status} ${name} ${f.size}`;
    });
    say('copy out:', savedStatus);
    say('saved', outZip, statSync(outZip).size, 'bytes');
    await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        for await (const [name] of root.entries()) await root.removeEntry(name);
    });
}
await ctx.close();
server.close();
process.exit(resultText && !errorText ? 0 : 1);
