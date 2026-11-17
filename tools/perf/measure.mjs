import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false, args: ['--enable-unsafe-webgpu', '--window-size=1440,900'] });
const page = await browser.newPage();
const MOBILE = process.env.MOBILE === '1';
await page.setViewport(MOBILE ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
const CX = MOBILE ? 195 : 500, CY = MOBILE ? 300 : 500;
await page.setCacheEnabled(false);
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  window.__ft = [];
  const loop = t => { window.__ft.push(t); if (window.__ft.length > 20000) window.__ft.splice(0, 5000); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.__lt = [];
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ entryTypes: ['longtask'] }); } catch {}
  window.__mark = () => performance.now();
  window.__gaps = since => {
    const f = window.__ft.filter(t => t >= since);
    const g = [];
    for (let i = 1; i < f.length; i++) g.push(f[i] - f[i - 1]);
    g.sort((a, b) => a - b);
    const q = p => g.length ? +g[Math.min(g.length - 1, Math.floor(p * g.length))].toFixed(1) : 0;
    return { n: g.length, avg: +(g.reduce((a, b) => a + b, 0) / (g.length || 1)).toFixed(1), p95: q(.95), max: +(g[g.length - 1] || 0).toFixed(1) };
  };
});
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const t0 = Date.now();
const ORIGIN = process.env.TEST_ORIGIN || 'http://localhost:8090';
const query = new URLSearchParams();
if (process.env.BACKEND) query.set('backend', process.env.BACKEND);
if (process.env.QUERY) for (const [k, v] of new URLSearchParams(process.env.QUERY)) query.set(k, v);
await page.goto(ORIGIN + '/index.html' + (query.size ? '?' + query.toString() : ''), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#gateEnter', { timeout: 30000 });
const gateReady = Date.now() - t0;
// A human reads the gate before entering; the GLB stream keeps running behind it.
await new Promise(r => setTimeout(r, Number(process.env.ENTER_DELAY || 1200)));
await page.click('#gateEnter');
const enterAt = await page.evaluate(() => window.__mark());
await page.waitForFunction(() => window.__VELANCE_QA__?.stats()?.loaded >= 1, { timeout: 120000 });
const firstCar = Date.now() - t0;
await page.waitForFunction(() => window.__VELANCE_QA__?.stats()?.loaded === 16, { timeout: 180000 });
const allLoaded = Date.now() - t0;
const bootGaps = await page.evaluate(s => window.__gaps(s), enterAt);
console.log(JSON.stringify({ backend: await page.evaluate(() => window.__VELANCE_QA__.stats().backend), gateReady, firstCar, allLoaded, enterToFirstCarGaps: bootGaps }));
// overview
await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight);
const ovAt = await page.evaluate(() => window.__mark());
await page.click('#overviewBtn');
await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight);
const ovFlight = await page.evaluate(s => window.__mark() - s, ovAt);
await page.mouse.move(CX, CY); await page.mouse.down();
for (let x = CX; x <= CX + (MOBILE ? 150 : 400); x += 40) { await page.mouse.move(x, CY); await new Promise(r => setTimeout(r, 40)); }
await page.mouse.up();
const ovGaps = await page.evaluate(s => window.__gaps(s), ovAt);
const ovStats = await page.evaluate(() => window.__VELANCE_QA__.stats());
console.log(JSON.stringify({ ovFlightMs: +ovFlight.toFixed(0), ovGaps, drawCalls: ovStats.drawCalls, triangles: ovStats.triangles, pixelRatio: await page.evaluate(() => window.__VELANCE_QA__.engine.renderer.getPixelRatio()) }));
await page.keyboard.press('Escape');
await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight);
// per-car select + orbit
const rows = [];
for (const i of [0, 4, 7, 8, 11, 15]) {
  const wantRow = i >= 8 ? 1 : 0;
  if (await page.evaluate(() => window.__VELANCE_QA__.engine.row) !== wantRow) { await page.click('#rowBtn'); await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight); }
  await page.evaluate(i => window.__VELANCE_QA__.engine.setFocus(i), i);
  await page.waitForFunction(i => Math.abs(window.__VELANCE_QA__.engine.position - i) < .01, {}, i);
  const at = await page.evaluate(() => window.__mark());
  await page.click('#selectCar');
  await page.waitForFunction(() => window.__VELANCE_QA__.engine.controls?.enabled && Number(getComputedStyle(document.querySelector('.selected-view')).opacity) > .99, { timeout: 60000 });
  const selMs = await page.evaluate(s => window.__mark() - s, at);
  await page.mouse.move(CX, CY); await page.mouse.down();
  for (let k = 0; k < 24; k++) { await page.mouse.move(CX + Math.sin(k / 3) * (MOBILE ? 120 : 260), CY + Math.cos(k / 4) * (MOBILE ? 40 : 60)); await new Promise(r => setTimeout(r, 33)); }
  await page.mouse.up();
  const gaps = await page.evaluate(s => window.__gaps(s), at);
  rows.push({ i, selMs: +selMs.toFixed(0), ...gaps });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight && window.__VELANCE_QA__.selected === null);
}
console.log('SELECT', JSON.stringify(rows));
console.log('LONGTASKS', JSON.stringify(await page.evaluate(() => window.__lt.slice(0, 40))));
console.log('ERRORS', JSON.stringify(errors));
await browser.close();