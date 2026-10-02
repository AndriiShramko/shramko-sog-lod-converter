// Renders the social share card web/public/og.png (1200×630) from HTML with Playwright.
//   node tools/og.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const avatar = readFileSync('web/public/img/andrii-shramko-320.webp').toString('base64');
const levels = [100, 50, 25, 12.5, 6.3, 3.1];
const bars = levels.map((p, i) => `<div class="lv"><span>LOD ${i}</span><i style="width:${Math.max(3, p * 2.6)}px"></i></div>`).join('');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:radial-gradient(1200px 630px at 85% 10%,#1d2633 0,#0b0d10 60%);color:#e7ecf1;font-family:"Segoe UI",system-ui,sans-serif;padding:64px 72px;position:relative;overflow:hidden}
.brand{display:flex;align-items:center;gap:14px;font-weight:700;font-size:30px;color:#ffb347}
.brand svg{width:44px;height:44px}
h1{font-size:56px;line-height:1.08;margin-top:34px;letter-spacing:-1px;max-width:640px}
p{font-size:27px;color:#aab6c2;margin-top:22px;max-width:640px;line-height:1.35}
.chips{display:flex;gap:12px;margin-top:30px}
.chips b{border:2px solid #2c3642;border-radius:999px;padding:8px 18px;font-size:22px;font-weight:600;color:#d7dee6}
.pyr{position:absolute;right:72px;top:170px;display:flex;flex-direction:column;gap:12px}
.lv{display:flex;align-items:center;gap:14px;font-size:20px;color:#8d99a6}
.lv span{width:70px;text-align:right}
.lv i{display:block;height:24px;border-radius:6px;background:linear-gradient(90deg,#ffb347,#ffd28a)}
.author{position:absolute;right:72px;bottom:56px;display:flex;align-items:center;gap:18px;font-size:24px;color:#c8d1da}
.author img{width:92px;height:92px;border-radius:50%;border:4px solid #ffb347;object-fit:cover}
.author b{display:block;color:#fff;font-size:28px}
</style></head><body>
<div class="brand"><svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="16" r="7" fill="none" stroke="currentColor" stroke-width="2" opacity=".7"/><circle cx="16" cy="16" r="2.5" fill="currentColor"/></svg>Shramko SOG LOD Converter</div>
<h1>Giant splat PLY → Streamed SOG with real LODs</h1>
<p>For SuperSplat's 10 GB limit. Runs in your browser on your own GPU — nothing uploaded, nothing to install.</p>
<div class="chips"><b>259M splats tested</b><b>Free · MIT</b></div>
<div class="pyr">${bars}</div>
<div class="author"><img src="data:image/webp;base64,${avatar}"><div><b>Andrii Shramko</b>sog.flyreelstudio.eu</div></div>
</body></html>`;

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: 'load' });
writeFileSync('web/public/og.png', await page.screenshot({ type: 'png' }));
await browser.close();
console.log('wrote web/public/og.png');
