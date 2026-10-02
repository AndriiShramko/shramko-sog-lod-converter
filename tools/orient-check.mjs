// Visual check of the preview & orientation panel in real Chrome.
//   node tools/orient-check.mjs <distDir> <file.ply> <outDir>
import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const [distArg, ply, out] = process.argv.slice(2);
const dist = resolve(distArg);
mkdirSync(out, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) { res.writeHead(204); return res.end(); }
    let p = join(dist, decodeURIComponent(url.pathname));
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    createReadStream(p).pipe(res);
}).listen(5191);

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addInitScript(() => { delete window.showOpenFilePicker; try { localStorage.clear(); localStorage.setItem('sog_consent', 'no'); } catch { /* */ } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5191/en/');
const t0 = Date.now();
await page.setInputFiles('#file-input', ply);
await page.waitForFunction(() => /Preview:/.test(document.getElementById('pv-status')?.textContent ?? ''), null, { timeout: 120000 });
console.log(`preview ready in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, await page.locator('#pv-status').innerText());
await page.locator('#orient').scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
const state = async () => ({ x: await page.inputValue('#o-x'), y: await page.inputValue('#o-y'), z: await page.inputValue('#o-z'), msg: await page.locator('#o-msg').innerText() });
console.log('after auto:', JSON.stringify(await state()));
await page.locator('#orient').screenshot({ path: join(out, '1-auto.png') });
await page.click('.pv-views button[data-view=side]');
await page.waitForTimeout(400);
await page.locator('#orient').screenshot({ path: join(out, '2-auto-side.png') });
await page.click('#o-flip');
await page.waitForTimeout(400);
console.log('after flip:', JSON.stringify(await state()));
await page.locator('#orient').screenshot({ path: join(out, '3-flipped-side.png') });
await page.click('.pv-views button[data-view=top]');
await page.waitForTimeout(400);
await page.locator('#orient').screenshot({ path: join(out, '4-flipped-top.png') });
console.log('floor fact:', (await page.locator('#fi-facts').innerText()).split('\n').filter(l => /First view|VR/.test(l)).join(' | '));
console.log('levels:', (await page.locator('#fi-levels').innerText()).split('\n').length - 1, 'rows');
console.log(errors.length ? `ERRORS: ${errors.join(' | ')}` : 'no page errors');
await browser.close();
server.close();
