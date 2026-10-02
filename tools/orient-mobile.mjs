// Phone-width screenshot of the preview & orientation panel on a site (live or local).
//   node tools/orient-mobile.mjs <https://site> <file.ply> <out.png>
import { chromium } from 'playwright';

const [base, ply, out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Mobile Safari/537.36' });
await ctx.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('sog_consent', 'no'); } catch { /* */ } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`${base.replace(/\/$/, '')}/en/`);
await page.setInputFiles('#file-input', ply);
await page.waitForFunction(() => /Preview:/.test(document.getElementById('pv-status')?.textContent ?? ''), null, { timeout: 120000 });
console.log(await page.locator('#pv-status').innerText());
await page.locator('#orient').scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log('horizontal overflow px:', overflow);
await page.locator('#orient').screenshot({ path: out });
console.log(errors.length ? `ERRORS: ${errors.join(' | ')}` : 'no page errors');
await browser.close();
