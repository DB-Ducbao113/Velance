import puppeteer from 'puppeteer-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const RUNS = Number(process.argv[2] || 4);
const p = (arr, q) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1); };

const collector = () => {
  window.__V = { lcp: 0, fcp: 0, cls: 0, events: [], longtasks: [], ttfb: 0, dcl: 0, load: 0, resBytes: 0, resCount: 0, biggest: [] };
  const V = window.__V;
  new PerformanceObserver(l => { for (const e of l.getEntries()) V.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') V.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) V.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.interactionId) V.events.push(e.duration); }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  new PerformanceObserver(l => { for (const e of l.getEntries()) V.longtasks.push(e.duration); }).observe({ type: 'longtask', buffered: true });
};
const cadence = ms => new Promise(res => {
  const d = []; let last = performance.now(); const t0 = last;
  const tick = () => { const n = performance.now(); d.push(n - last); last = n; if (n - t0 < ms) requestAnimationFrame(tick); else res({ p50: +d.sort((a, b) => a - b)[Math.floor(d.length * .5)].toFixed(1), p95: +d[Math.floor(d.length * .95)].toFixed(1), p99: +d[Math.floor(d.length * .99)].toFixed(1), max: +d[d.length - 1].toFixed(1) }); };
  requestAnimationFrame(tick);
});

const runs = [];
for (let r = 0; r < RUNS; r++) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, args: ['--window-size=1440,900'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  await page.evaluateOnNewDocument(collector);
  await page.goto('http://localhost:8090/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__NOIR_QA__ && window.__NOIR_QA__.stats().loaded === 8, { timeout: 60000 });
  await new Promise(res => setTimeout(res, 1200));
  const gateIdle = await page.evaluate(cadence, 1200);
  const enterP = page.evaluate(cadence, 2600);
  await page.click('#gateEnter');
  const enter = await enterP;
  await page.evaluate(() => window.__NOIR_QA__.engine.setFocus(0));
  await new Promise(res => setTimeout(res, 500));
  const selP = page.evaluate(cadence, 1500);
  await page.click('#selectCar');
  const sel = await selP;
  await new Promise(res => setTimeout(res, 900));
  const v = await page.evaluate(() => {
    const V = window.__V;
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const res = performance.getEntriesByType('resource');
    V.ttfb = nav.responseStart || 0; V.dcl = nav.domContentLoadedEventEnd || 0; V.load = nav.loadEventEnd || 0;
    V.resBytes = res.reduce((a, e) => a + (e.transferSize || 0), 0); V.resCount = res.length;
    V.biggest = res.map(e => ({ n: e.name.split('/').pop().slice(0, 40), kb: Math.round((e.transferSize || 0) / 1024), ms: Math.round(e.duration) })).sort((a, b) => b.kb - a.kb).slice(0, 6);
    V.inp = V.events.length ? Math.max(...V.events) : 0;
    V.inpP95 = V.events.length ? [...V.events].sort((a, b) => a - b)[Math.floor(V.events.length * .95)] : 0;
    V.tbt = V.longtasks.reduce((a, d) => a + Math.max(0, d - 50), 0);
    V.stats = window.__NOIR_QA__.stats();
    return V;
  });
  runs.push({ run: r, ttfb: +v.ttfb.toFixed(1), fcp: +v.fcp.toFixed(0), lcp: +v.lcp.toFixed(0), cls: +v.cls.toFixed(3), inp: +v.inp.toFixed(0), inpP95: +v.inpP95.toFixed(0), tbt: +v.tbt.toFixed(0), dcl: +v.dcl.toFixed(0), load: +v.load.toFixed(0), resKB: Math.round(v.resBytes / 1024), resCount: v.resCount, gateIdle, enter, sel, renderP95: v.stats.renderMsP95, biggest: v.biggest });
  await browser.close();
}
const agg = k => ({ p50: p(runs.map(x => x[k]), .5), p95: p(runs.map(x => x[k]), .95), p99: p(runs.map(x => x[k]), .99) });
console.log('PER_RUN', JSON.stringify(runs.map(({ biggest, gateIdle, enter, sel, ...rest }) => rest)));
console.log('VITALS_AGG', JSON.stringify({ ttfb: agg('ttfb'), fcp: agg('fcp'), lcp: agg('lcp'), cls: agg('cls'), inp: agg('inp'), tbt: agg('tbt'), load: agg('load'), resKB: agg('resKB') }));
console.log('FRAME_GATE_P95p99', JSON.stringify({ p95: p(runs.map(x => x.gateIdle.p95), .95), p99: p(runs.map(x => x.gateIdle.p99), .99) }));
console.log('FRAME_ENTER_P95p99', JSON.stringify({ p95: p(runs.map(x => x.enter.p95), .95), p99: p(runs.map(x => x.enter.p99), .99), max: p(runs.map(x => x.enter.max), .99) }));
console.log('FRAME_SELECT_P95p99', JSON.stringify({ p95: p(runs.map(x => x.sel.p95), .95), p99: p(runs.map(x => x.sel.p99), .99), max: p(runs.map(x => x.sel.max), .99) }));
console.log('BIGGEST', JSON.stringify(runs[0].biggest));
console.log('DONE');