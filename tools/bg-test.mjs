// Does a conversion keep its speed when the page is hidden (window minimized / tab in background)?
// Playwright fakes focus and visibility on every page it drives (even over connectOverCDP), so this
// starts a plain Chrome and talks raw DevTools protocol: nothing emulated, real hidden states.
//   node tools/bg-test.mjs <dist> <file.ply> [--minimize|--background-tab] [--port 5189]
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const [distArg, ply] = args.filter(a => !a.startsWith('--'));
const mode = args.includes('--minimize') ? 'minimize' : args.includes('--background-tab') ? 'background-tab' : 'visible';
const PORT = parseInt(args[args.indexOf('--port') + 1] ?? '5189', 10) || 5189;
const dist = resolve(distArg);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) { res.writeHead(204); return res.end(); }
    if (url.pathname === '/__ply') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return createReadStream(ply).pipe(res); }
    let p = join(dist, decodeURIComponent(url.pathname));
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    createReadStream(p).pipe(res);
}).listen(PORT);

const DEBUG = 9333;
const profile = mkdtempSync(join(tmpdir(), 'sog-bg-'));
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [`--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu', `http://localhost:${PORT}/en/`], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(3000);

const targets = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
const target = targets.find(t => t.type === 'page' && t.url.includes(`:${PORT}`));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0;
const waiting = new Map();
ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).substring(0, 400));
    return m.result?.result?.value;
};

for (let i = 0; i < 40 && !(await ev(`!!document.getElementById('file-input')`)); i++) await sleep(250);
await ev(`(async () => {
    delete window.showOpenFilePicker;
    window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('bg.zip', { create: true });
    localStorage.setItem('sog_consent', 'no');
    const r = document.querySelector('input[name=preset][value=all]'); r.checked = true; r.dispatchEvent(new Event('change'));
    const b = await (await fetch('/__ply')).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([b], 'sample.ply'));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return true;
})()`);
for (let i = 0; i < 240 && !(await ev(`/Preview:/.test(document.getElementById('pv-status')?.textContent ?? '')`)); i++) await sleep(500);
// click with a user gesture (the save dialog needs one; here it is replaced by browser storage anyway)
await send('Runtime.evaluate', { expression: `document.getElementById('convert').click()`, userGesture: true });
const t0 = Date.now();
await sleep(3000);
if (mode === 'minimize') {
    const { result } = await send('Browser.getWindowForTarget');
    await send('Browser.setWindowBounds', { windowId: result.windowId, bounds: { windowState: 'minimized' } });
} else if (mode === 'background-tab') {
    await fetch(`http://127.0.0.1:${DEBUG}/json/new?about:blank`, { method: 'PUT' });
}
await sleep(2000);
const vis = [];
for (;;) {
    await sleep(5000);
    const st = await ev(`({ why: document.getElementById('convert-why').textContent, v: document.visibilityState, done: !document.getElementById('result').hidden, failed: !document.getElementById('error').hidden, running: !document.getElementById('progress').hidden, pct: document.getElementById('p-pct').textContent })`);
    vis.push(st.v);
    if (st.done || st.failed || (!st.running && Date.now() - t0 > 20000)) {
        console.log(`mode ${mode}: ${st.done ? 'done' : st.failed ? 'FAILED' : `stopped? (${st.why})`} after ${((Date.now() - t0) / 1000).toFixed(0)} s; visibility while running: ${[...new Set(vis)].join('/')}`);
        break;
    }
}
ws.close();
proc.kill();
server.close();
process.exit(0);
