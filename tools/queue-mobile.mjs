// Phone-width screenshot of the queue panel (files added, not started) on a site.
//   node tools/queue-mobile.mjs <https://site> <out.png> <a.ply> [b.ply ...]
import { chromium } from 'playwright';

const [base, out, ...plys] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Mobile Safari/537.36' });
await ctx.addInitScript(() => { try { localStorage.setItem('sog_consent', 'no'); } catch { /* */ } delete window.showOpenFilePicker; });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`${base.replace(/\/$/, '')}/en/`);
for (const p of plys) {
    await page.setInputFiles('#file-input', p);
    await page.waitForFunction(() => /Preview:|Too few/.test(document.getElementById('pv-status')?.textContent ?? ''), null, { timeout: 120000 });
    const n = await page.locator('#q-list li').count();
    await page.click('#enqueue');
    await page.waitForFunction(k => document.querySelectorAll('#q-list li').length > k, n);
}
await page.locator('#queue').scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
console.log('horizontal overflow px:', await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth));
await page.locator('#step-run').screenshot({ path: out });
console.log(errors.length ? `ERRORS: ${errors.join(' | ')}` : 'no page errors');
await browser.close();
