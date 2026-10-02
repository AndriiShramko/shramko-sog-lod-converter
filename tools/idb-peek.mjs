// Debug helper: print the saved queue (IndexedDB) of a test profile.
//   node tools/idb-peek.mjs <profileDir> [port]
import http from 'node:http';
import { chromium } from 'playwright';

const [profile, portArg] = process.argv.slice(2);
const PORT = parseInt(portArg ?? '5199', 10);
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>peek</title>'); }).listen(PORT);
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto(`http://localhost:${PORT}/`);
const out = await page.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open('sog-queue', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => {
        const tx = r.result.transaction('kv', 'readonly');
        const g = tx.objectStore('kv').get('queue_v1');
        g.onsuccess = () => {
            const v = g.result;
            resolve(v ? { savedAt: new Date(v.savedAt).toISOString(), dir: v.dir ? `${v.dir.kind}:${v.dir.name}` : null, items: v.items.map(i => `${i.name}:${i.status}${i.outputName ? `→${i.outputName}` : ''}`) } : null);
        };
        g.onerror = () => resolve({ error: String(g.error) });
    };
    r.onerror = () => resolve({ error: String(r.error) });
}));
console.log(JSON.stringify(out, null, 1));
await ctx.close();
server.close();
