// Batch run of the real site's QUEUE in real Chrome (Playwright) — acceptance test and agent driver.
//
//   node tools/queue.mjs <list.json> <outDir> [--dist dist] [--mem 8] [--profile dir] [--port 5186]
//                        [--log file] [--reload-after N] [--expect done,done,failed,...]
//                        [--base https://sog.flyreelstudio.eu]   (the live site: results are listed, not copied)
//
// list.json: [{ "ply": "U:/a.ply", "rotate": "-90,0,0", "preset": "all", "centre": true, "doubleClick": false }, ...]
// Checks on the way (each prints CHECK ok/FAIL): buttons hidden/shown correctly, a double click on
// "Add to queue" before the preview is ready adds the file once, a second tab does not offer to
// resume the running queue, and output names keep non-Latin letters.
//
// Each file is picked through the page's own <input>, its preset and rotation are set the way a
// user does it, and "Add to queue" is pressed. Then "Start the queue": the folder dialog cannot be
// automated, so showDirectoryPicker returns a folder in the browser's private storage (OPFS) — the
// queue writes there through the same FileSystemFileHandle.createWritable() path. --reload-after N
// reloads the page after N files are done (a closed tab), picks the files again and resumes, to
// prove the queue survives. At the end every archive is copied to <outDir>.

import http from 'node:http';
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const [listFile, outDir] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!listFile || !outDir) { console.error('usage: queue.mjs <list.json> <outDir> [...]'); process.exit(2); }
const list = JSON.parse(readFileSync(listFile, 'utf8'));
const dist = resolve(opt('--dist', 'dist'));
const mem = opt('--mem', '8');
const profile = opt('--profile', '.queue-profile');
const PORT = parseInt(opt('--port', '5186'), 10);
const logFile = opt('--log', '');
const reloadAfter = parseInt(opt('--reload-after', '0'), 10);
const expect = opt('--expect', '');
const base = opt('--base', '');
mkdirSync(outDir, { recursive: true });

const checks = [];
const check = (ok, what) => {
    checks.push({ ok, what });
    say(`CHECK ${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
const say = (...a) => {
    const line = `${new Date().toISOString().substring(11, 19)} ${a.join(' ')}`;
    console.log(line);
    if (logFile) appendFileSync(logFile, `${line}\n`);
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.txt': 'text/plain', '.xml': 'application/xml' };
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/__save' && req.method === 'PUT') {
        const name = (url.searchParams.get('name') ?? 'out.zip').replace(/[\\/:*?"<>|]/g, '_');
        const out = createWriteStream(join(outDir, name));
        req.pipe(out);
        out.on('finish', () => { res.writeHead(200); res.end('saved'); });
        out.on('error', () => { res.writeHead(500); res.end(); });
        return;
    }
    if (url.pathname.startsWith('/api/')) {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, id: 'R-STUB-Q' }));
        });
        return;
    }
    let p = join(dist, decodeURIComponent(url.pathname));
    if (url.pathname === '/') { res.writeHead(302, { location: '/en/' }); return res.end(); }
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!existsSync(p)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(p).pipe(res);
});
if (!base) server.listen(PORT);
const origin = base ? base.replace(/\/$/, '') : `http://localhost:${PORT}`;

const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--enable-unsafe-webgpu']
});
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
await ctx.addInitScript(() => {
    delete window.showOpenFilePicker; // pick through <input> (no native dialog)
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('queue-out', { create: true });
    try { localStorage.setItem('sog_consent', 'no'); } catch { /* */ }
});
const page = ctx.pages()[0] ?? await ctx.newPage();
page.on('pageerror', e => say('[pageerror]', e.message));
page.on('console', m => { if (m.type() === 'error' || /queue:/.test(m.text())) say(`[console.${m.type()}]`, m.text().substring(0, 300)); });
page.on('crash', () => say('[CRASH]'));

const open = async () => {
    await page.goto(`${origin}/en/`);
    await page.waitForSelector('#drop');
};
const items = async () => page.$$eval('#q-list li', lis => lis.map(li => ({ id: li.dataset.id, status: li.className.replace('q-item', '').trim(), name: li.querySelector('b')?.textContent, meta: li.querySelector('.q-meta')?.textContent, state: li.querySelector('.q-state')?.textContent })));

await open();
// clean slate: an old queue in this profile, old results in OPFS
await page.evaluate(async () => {
    indexedDB.deleteDatabase('sog-queue');
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
});
await open();
await page.click('#advanced summary');
await page.fill('#s-mem', String(mem));
await page.locator('#s-mem').dispatchEvent('change');

// ---- add every file to the queue
for (const [k, it] of list.entries()) {
    if (it.preset) await page.check(`input[name=preset][value=${it.preset}]`, { force: true });
    await page.setInputFiles('#file-input', it.ply);
    await page.waitForFunction(() => !document.getElementById('file-info').hidden && (document.querySelectorAll('#fi-levels tr').length > 0 || !document.getElementById('fi-warn').hidden), null, { timeout: 60000 });
    if (it.doubleClick) {
        // two quick clicks while the preview may still be loading: the file must be queued once
        const before = (await items()).length;
        await page.evaluate(() => { const b = document.getElementById('enqueue'); b.click(); b.click(); });
        await page.waitForFunction(n => document.querySelectorAll('#q-list li').length > n, before, { timeout: 120000 });
        await page.waitForTimeout(2500);
        const after = (await items()).length;
        check(after === before + 1, `double click on "Add to queue" added ${after - before} item(s) (expected 1)`);
        const now = await items();
        say(`added ${k + 1}/${list.length}:`, now[now.length - 1].name, '|', now[now.length - 1].meta);
        continue;
    }
    await page.waitForFunction(() => /Preview:|could not|no WebGL2|Too few/i.test(document.getElementById('pv-status')?.textContent ?? ''), null, { timeout: 180000 });
    if (it.rotate) {
        const [rx, ry, rz] = it.rotate.split(',');
        await page.fill('#o-x', rx);
        await page.fill('#o-y', ry);
        await page.fill('#o-z', rz);
        await page.locator('#o-z').dispatchEvent('change');
    }
    if (it.centre !== undefined) {
        await page.setChecked('#o-centre', !!it.centre);
        await page.locator('#o-centre').dispatchEvent('change');
    }
    const before = (await items()).length;
    await page.click('#enqueue');
    await page.waitForFunction(n => document.querySelectorAll('#q-list li').length > n, before, { timeout: 60000 });
    const now = await items();
    say(`added ${k + 1}/${list.length}:`, now[now.length - 1].name, '|', now[now.length - 1].meta);
}
say('queue summary:', await page.locator('#q-summary').innerText());
const vis = async id => page.locator(`#${id}`).isVisible();
check(await vis('q-start') && !(await vis('q-pause')) && !(await vis('q-clear')), 'before start: Start shown, Pause and Clear finished hidden');

// ---- run
await page.click('#q-start');
await page.waitForTimeout(1500);
check(!(await vis('q-start')) && await vis('q-pause'), 'running: Start hidden, Pause shown');
check(!(await page.locator('#convert').isEnabled()), 'running queue: single Convert disabled');
{
    // a second tab while the queue runs: no resume offer, a clear note instead
    const p2 = await ctx.newPage();
    await p2.goto(`${origin}/en/`);
    await p2.waitForTimeout(1500);
    const other = await p2.locator('#other-tab').isVisible();
    const resumeOffered = await p2.locator('#q-resume').isVisible();
    const crashShown = await p2.locator('#crash').isVisible();
    check(other && !resumeOffered && !crashShown, `second tab: "working in another tab" ${other}, resume offered ${resumeOffered}, false crash banner ${crashShown}`);
    await p2.close();
}
const t0 = Date.now();
let reloaded = false;
const reloadAndResume = async () => {
    reloaded = true;
    say(`--- reload right after ${reloadAfter} done (a tab that dies at the worst moment) ---`);
    await open();
    const banner = await page.locator('#q-resume').isVisible();
    say('resume banner visible:', String(banner), '|', await page.locator('#q-resume-text').innerText().catch(() => ''));
    const after = await items();
    say('after reload:', JSON.stringify(after.map(i => `${i.name}:${i.status}`)));
    check(after.filter(i => i.status === 'done').length >= reloadAfter, `the ${reloadAfter} finished file(s) are still "done" after the reload (not converted again)`);
    // files picked through <input> have no handle: pick them again (the queue matches name + size)
    await page.setInputFiles('#file-input', [...new Set(list.map(i => i.ply))]);
    await page.waitForTimeout(800);
    say('re-attached:', await page.locator('#q-msg').innerText(), '|', JSON.stringify((await items()).map(i => `${i.name}:${i.status}`)));
    await page.click('#q-resume-go');
};
if (reloadAfter) {
    // reload the moment the N-th file shows "done" (polling every 20 ms)
    await page.waitForFunction(n => document.querySelectorAll('#q-list li.done').length >= n, reloadAfter, { timeout: 0, polling: 20 });
    await reloadAndResume();
}
let last = '';
for (;;) {
    await page.waitForTimeout(3000);
    const st = await page.evaluate(() => ({
        doneBanner: !document.getElementById('q-done').hidden ? document.getElementById('q-done').textContent : '',
        summary: document.getElementById('q-summary')?.textContent,
        pct: document.getElementById('p-pct')?.textContent,
        job: document.getElementById('p-job')?.textContent,
        title: document.title,
        msg: document.getElementById('q-msg')?.textContent
    })).catch(e => ({ crashed: String(e) }));
    if (st.crashed) { say('page gone:', st.crashed); break; }
    const its = await items();
    const line = `${its.map(i => i.status[0]).join('')} | ${st.summary} | ${st.job} ${st.pct} | ${st.title}`;
    if (line !== last) say(line);
    last = line;
    if (st.doneBanner) { say('FINISHED:', st.doneBanner); break; }
}
const elapsed = (Date.now() - t0) / 1000;
const final = await items();
check(await vis('q-start') && !(await vis('q-pause')) && await vis('q-clear'), 'finished: Start shown (disabled), Pause hidden, Clear finished shown');
for (const i of final) say(`  ${i.status.padEnd(9)} ${i.name} — ${i.state}`);
say('copy summary:\n' + await page.evaluate(async () => {
    document.getElementById('q-copy').click();
    await new Promise(r => setTimeout(r, 300));
    return navigator.clipboard.readText().catch(() => '(clipboard not readable)');
}));

// ---- copy results out of OPFS
const saved = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('queue-out', { create: true });
    const out = [];
    for await (const [name, h] of dir.entries()) {
        const f = await h.getFile();
        if (location.port === '' && location.protocol === 'https:') {
            out.push(`kept ${name} ${f.size}`);  // live site: no test endpoint, just list
            continue;
        }
        const r = await fetch(`/__save?name=${encodeURIComponent(name)}`, { method: 'PUT', body: f });
        out.push(`${r.status} ${name} ${f.size}`);
    }
    return out;
});
say('copied out:', JSON.stringify(saved));
for (const it of list) {
    const stem = it.ply.split(/[\\/]/).pop().replace(/\.ply$/i, '');
    if (/[^\x00-\x7f]/.test(stem)) {
        const want = stem.replace(/[^\p{L}\p{N}._\-]+/gu, '_');
        check(saved.some(x => x.includes(` ${want}-SSOG`)), `non-Latin name kept: ${want}-SSOG*.zip`);
    }
}
say(`queue took ${elapsed.toFixed(0)} s`);
await ctx.close();
if (!base) server.close();
let ok = checks.every(c => c.ok);
if (expect) {
    const got = final.map(i => i.status).join(',');
    const st = got === expect;
    say(st ? `PASS statuses ${got}` : `FAIL statuses ${got} (expected ${expect})`);
    ok = ok && st;
}
say(`${checks.filter(c => c.ok).length}/${checks.length} checks ok`);
process.exit(ok ? 0 : 1);
