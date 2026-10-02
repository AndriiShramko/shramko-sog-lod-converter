// Acceptance checks against the LIVE site in real Chrome (Playwright).
//   node tools/live-check.mjs --base https://sog.flyreelstudio.eu --ply sample.ply --broken broken.ply [--skip-feedback]
// Each check prints PASS/FAIL with what it saw. Feedback/lead/error checks send REAL messages
// (marked [TEST]) to the site's API and Telegram bot.

import { chromium } from 'playwright';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const base = arg('--base', 'https://sog.flyreelstudio.eu');
const ply = arg('--ply', '');
const broken = arg('--broken', '');
const skipFeedback = process.argv.includes('--skip-feedback');
const results = [];
const check = (ok, name, detail = '') => {
    results.push({ ok, name, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });

// --- 1. GA consent: nothing from Google before Accept, a real collect hit after
{
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const google = [];
    page.on('request', r => { if (/google-analytics|googletagmanager/.test(r.url())) google.push(r.url().split('?')[0]); });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/en/`, { waitUntil: 'networkidle' });
    check(await page.isVisible('#consent'), 'consent banner shown on first visit');
    check(google.length === 0, 'no Google requests before consent', `${google.length} requests`);
    await page.click('#consent-no');
    await page.reload({ waitUntil: 'networkidle' });
    check(google.length === 0 && !(await page.isVisible('#consent')), 'Decline remembered, still no Google requests');
    await ctx.close();

    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    const hits = [];
    p2.on('response', r => { if (/\/g\/collect/.test(r.url())) hits.push(r.status()); });
    await p2.goto(`${base}/en/`, { waitUntil: 'networkidle' });
    await p2.click('#consent-yes');
    await p2.waitForTimeout(6000);
    const cookies = (await ctx2.cookies()).map(c => c.name);
    check(hits.some(s => s === 204 || s === 200), 'after Accept: GA4 collect hit answered', `statuses ${JSON.stringify(hits)}`);
    check(cookies.some(c => c.startsWith('_ga')), 'after Accept: _ga cookie set', cookies.filter(c => c.startsWith('_ga')).join(','));
    check(errors.length === 0, 'no page errors on /en/', errors.slice(0, 3).join(' | '));
    await ctx2.close();
}

// --- 2. language switch: every link works and the choice is remembered
{
    const ctx = await browser.newContext({ locale: 'en-US' });
    const page = await ctx.newPage();
    await page.goto(`${base}/en/`);
    for (const l of ['es', 'pl', 'ru', 'en']) {
        await page.click(`header .langs a[data-lang=${l}]`);
        await page.waitForLoadState('domcontentloaded');
        const lang = await page.evaluate(() => document.documentElement.lang);
        check(lang === l && page.url().endsWith(`/${l}/`), `language switch → ${l}`, `${new URL(page.url()).pathname} lang=${lang}`);
    }
    await page.click('header .langs a[data-lang=pl]');
    await page.goto(`${base}/`);
    check(new URL(page.url()).pathname === '/pl/', 'remembered choice: "/" goes to the last picked language', new URL(page.url()).pathname);
    await ctx.close();
}

const converterPage = async () => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
        delete window.showOpenFilePicker;
        window.showSaveFilePicker = async (o) => (await navigator.storage.getDirectory()).getFileHandle(o?.suggestedName ?? 'out.zip', { create: true });
        try { localStorage.setItem('sog_consent', 'no'); } catch { /* */ }
    });
    const page = await ctx.newPage();
    return { ctx, page };
};

// --- 3. a real conversion on the live site
if (ply) {
    const { ctx, page } = await converterPage();
    await page.goto(`${base}/en/`);
    await page.check('input[name=preset][value=aerial]', { force: true });
    await page.setInputFiles('#file-input', ply);
    await page.waitForSelector('#fi-levels tr');
    const t0 = Date.now();
    await page.click('#convert');
    await page.waitForFunction(() => !document.getElementById('result').hidden || !document.getElementById('error').hidden, null, { timeout: 30 * 60 * 1000 });
    const res = await page.locator('#result').innerText().catch(() => '');
    check(/Checked: lod-meta\.json at the root/.test(res), 'live conversion (preset aerial) finished and verified', `${((Date.now() - t0) / 1000).toFixed(0)} s; ${res.split('\n').slice(1, 3).join(' | ')}`);
    await ctx.close();
}

// --- 4. a broken file: visible error + automatic anonymous report
if (broken) {
    const { ctx, page } = await converterPage();
    const reports = [];
    page.on('response', async r => { if (r.url().endsWith('/api/report')) reports.push({ status: r.status(), body: await r.json().catch(() => null) }); });
    await page.goto(`${base}/en/`);
    await page.setInputFiles('#file-input', broken);
    await page.waitForSelector('#fi-levels tr');
    await page.click('#convert');
    await page.waitForSelector('#error:not([hidden])', { timeout: 120000 });
    await page.waitForTimeout(3000);
    const txt = await page.locator('#error').innerText();
    check(/stopped/i.test(txt) && /Step:/.test(txt), 'broken input: error panel with the step is shown', txt.split('\n').slice(0, 3).join(' | '));
    const rep = reports.find(r => r.status === 200);
    check(!!rep && /^R-\d{8}-\d{4}$/.test(rep.body?.id ?? ''), 'error report sent automatically', JSON.stringify(rep?.body ?? reports));
    check(/R-\d{8}-\d{4}/.test(txt), 'report number shown to the user');
    await ctx.close();
}

// --- 5. feedback dialog (bug without diagnostics = negative control, idea) and the lead form
if (!skipFeedback) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { try { localStorage.setItem('sog_consent', 'no'); } catch { /* */ } });
    const page = await ctx.newPage();
    const posts = [];
    page.on('response', async r => { if (/\/api\/(report|lead)$/.test(r.url())) posts.push({ url: new URL(r.url()).pathname, status: r.status(), body: await r.json().catch(() => null) }); });
    await page.goto(`${base}/en/`);
    // bug, diagnostics UNticked
    await page.click('#fb-open');
    await page.check('#fb input[name=kind][value=bug]', { force: true });
    await page.fill('#fb textarea[name=message]', '[TEST] automated acceptance check: bug report WITHOUT diagnostics. Please ignore.');
    await page.uncheck('#fb input[name=diag]');
    await page.click('#fb-send');
    await page.waitForFunction(() => /R-\d{8}-\d{4}/.test(document.querySelector('#fb .form-status')?.textContent ?? ''), null, { timeout: 30000 });
    // idea
    await page.check('#fb input[name=kind][value=idea]', { force: true });
    await page.fill('#fb textarea[name=message]', '[TEST] automated acceptance check: idea. Please ignore.');
    await page.click('#fb-send');
    await page.waitForTimeout(5000);
    await page.click('#fb-close');
    // lead (cooperation)
    await page.locator('#contact').scrollIntoViewIfNeeded();
    await page.check('#lead input[name=role][value=developer]', { force: true });
    await page.fill('#lead input[name=email]', 'zmei116@gmail.com');
    await page.fill('#lead textarea[name=message]', '[TEST] automated acceptance check of the cooperation form. Please ignore.');
    await page.check('#lead input[name=consent]');
    await page.waitForTimeout(3200);
    await page.click('#lead button[type=submit]');
    await page.waitForTimeout(5000);
    const rep = posts.filter(p => p.url === '/api/report');
    const lead = posts.find(p => p.url === '/api/lead');
    check(rep.length === 2 && rep.every(r => r.status === 200 && r.body?.ok), 'feedback: bug + idea stored', JSON.stringify(rep.map(r => r.body)));
    check(rep.every(r => r.body?.delivered === true), 'feedback: both delivered to Telegram', JSON.stringify(rep.map(r => r.body?.delivered)));
    check(rep[0]?.body?.diagnostics === false, 'negative control: bug without consent stored NO diagnostics', `diagnostics=${rep[0]?.body?.diagnostics}`);
    check(lead?.status === 200 && lead.body?.delivered === true, 'cooperation lead stored and delivered', JSON.stringify(lead?.body));
    await ctx.close();
}

await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
