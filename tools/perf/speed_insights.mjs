/* Lab benchmark: cold-load Web Vitals + asset/VRAM budget + frame cadence per journey step.
 * node speed_insights.mjs [runs] [--url URL] [--label NAME] [--out results.json] [--shots DIR]
 */
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const RUNS = Number(args.find((a, i) => /^\d+$/.test(a) && !args[i - 1]?.startsWith('--')) || 4);
const URL_ = flag('--url', 'http://localhost:8090/index.html');
const LABEL = flag('--label', 'run');
const OUT = flag('--out', null);
const SHOTS = flag('--shots', null);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = (arr, q, digits = 1) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(digits); };

const collector = () => {
  window.__V = { lcp: 0, fcp: 0, cls: 0, events: [], longtasks: [], heroAt: null, allAt: null };
  const V = window.__V;
  new PerformanceObserver(l => { for (const e of l.getEntries()) V.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') V.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) V.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.interactionId) V.events.push(e.duration); }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  new PerformanceObserver(l => { for (const e of l.getEntries()) V.longtasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true });
  const poll = setInterval(() => {
    const s = window.__VELANCE_QA__?.stats?.();
    if (!s) return;
    if (V.heroAt === null && s.loaded >= 1) V.heroAt = performance.now();
    if (V.allAt === null && s.loaded >= s.total) { V.allAt = performance.now(); clearInterval(poll); }
  }, 16);
};
const cadence = ms => new Promise(res => {
  const d = []; let last = performance.now(); const t0 = last;
  const tick = () => {
    const n = performance.now(); d.push(n - last); last = n;
    if (n - t0 < ms) return requestAnimationFrame(tick);
    d.sort((a, b) => a - b);
    const q = k => +d[Math.min(d.length - 1, Math.floor(d.length * k))].toFixed(1);
    res({ p50: q(.5), p95: q(.95), p99: q(.99), max: +d[d.length - 1].toFixed(1), frames: d.length });
  };
  requestAnimationFrame(tick);
});
const sceneBudget = () => {
  const eng = window.__VELANCE_QA__.engine;
  const seen = new Set(); let bytes = 0, compressed = 0;
  eng.scene.traverse(o => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) for (const key of Object.keys(m)) {
      const t = m[key];
      if (!t || !t.isTexture || seen.has(t)) continue;
      seen.add(t);
      if (t.isCompressedTexture) { compressed++; bytes += (t.mipmaps || []).reduce((a, mm) => a + (mm.data?.byteLength || 0), 0); }
      else if (t.image?.width) bytes += t.image.width * t.image.height * 4 * (t.generateMipmaps === false ? 1 : 4 / 3);
    }
  });
  const r = eng.renderer;
  return { textures: seen.size, compressed, textureMB: +(bytes / 1048576).toFixed(1), backend: r.backend ? (r.backend.isWebGPUBackend ? 'webgpu' : 'webgl2') : 'webgl' };
};
async function drag(page, selector, dx, ms) {
  const box = await (await page.$(selector)).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  const steps = Math.round(ms / 16);
  for (let i = 1; i <= steps; i++) { await page.mouse.move(x + dx * Math.sin(i / steps * Math.PI * 2), y + 8 * Math.sin(i / steps * Math.PI)); await sleep(16); }
  await page.mouse.up();
}

const runs = [];
for (let r = 0; r < RUNS; r++) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, args: ['--window-size=1440,900', '--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  await page.evaluateOnNewDocument(collector);
  await page.goto(URL_, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__V?.allAt !== null && window.__V?.allAt !== undefined, { timeout: 90000 });
  await sleep(1200);
  const gateIdle = await page.evaluate(cadence, 1200);
  const enterP = page.evaluate(cadence, 2600);
  await page.click('#gateEnter');
  const enter = await enterP;
  await page.evaluate(() => window.__VELANCE_QA__.engine.setFocus(0));
  await sleep(600);
  const homeStats = await page.evaluate(() => window.__VELANCE_QA__.stats());
  if (SHOTS && r === 0) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${LABEL}-home.png`) }); }
  const selP = page.evaluate(cadence, 1500);
  await page.click('#selectCar');
  const sel = await selP;
  await sleep(900);
  if (SHOTS && r === 0) await page.screenshot({ path: join(SHOTS, `${LABEL}-selected.png`) });
  const orbitP = page.evaluate(cadence, 2000);
  await drag(page, '#selectedModelHost', 260, 2000);
  const orbit = await orbitP;
  const selStats = await page.evaluate(() => window.__VELANCE_QA__.stats());
  if (SHOTS && r === 0) {
    await page.evaluate(() => { const q = window.__VELANCE_QA__; q.engine.setPaint(q.selected, '#7c1418'); });
    await sleep(400);
    await page.screenshot({ path: join(SHOTS, `${LABEL}-selected-rosso.png`) });
    await page.evaluate(() => { const q = window.__VELANCE_QA__; q.engine.setPaint(q.selected, null); });
  }
  await page.keyboard.press('Escape');
  await sleep(1400);
  const ovP = page.evaluate(cadence, 1600);
  await page.click('#overviewBtn');
  const overview = await ovP;
  await sleep(500);
  if (SHOTS && r === 0) await page.screenshot({ path: join(SHOTS, `${LABEL}-overview.png`) });
  const panP = page.evaluate(cadence, 1500);
  await drag(page, '#carStage', 300, 1500);
  const pan = await panP;
  const v = await page.evaluate(sceneBudget).then(async budget => page.evaluate(b => {
    const V = window.__V;
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const res = performance.getEntriesByType('resource');
    const byType = {};
    for (const e of res) {
      const ext = (e.name.split('?')[0].split('.').pop() || 'other').toLowerCase();
      const k = ['glb', 'js', 'webp', 'png', 'jpg', 'css', 'ktx2', 'wasm'].includes(ext) ? ext : 'other';
      byType[k] = (byType[k] || 0) + (e.encodedBodySize || e.transferSize || 0);
    }
    for (const k in byType) byType[k] = +(byType[k] / 1048576).toFixed(2);
    const allAt = V.allAt || performance.now();
    const loadTasks = V.longtasks.filter(t => t.start < allAt);
    return {
      ttfb: nav.responseStart || 0, fcp: V.fcp, lcp: V.lcp, cls: V.cls, load: nav.loadEventEnd || 0,
      inp: V.events.length ? Math.max(...V.events) : 0,
      tbt: V.longtasks.reduce((a, t) => a + Math.max(0, t.dur - 50), 0),
      loadLongTaskMs: loadTasks.reduce((a, t) => a + t.dur, 0), loadLongTaskMax: loadTasks.reduce((a, t) => Math.max(a, t.dur), 0),
      heroMs: V.heroAt, allMs: V.allAt,
      mbTotal: +(res.reduce((a, e) => a + (e.encodedBodySize || e.transferSize || 0), 0) / 1048576).toFixed(2), byType,
      budget: b, stats: window.__VELANCE_QA__.stats()
    };
  }, budget));
  runs.push({
    run: r, ttfb: +v.ttfb.toFixed(1), fcp: Math.round(v.fcp), lcp: Math.round(v.lcp), cls: +v.cls.toFixed(3), inp: Math.round(v.inp), tbt: Math.round(v.tbt),
    heroMs: Math.round(v.heroMs), allMs: Math.round(v.allMs), loadLongTaskMs: Math.round(v.loadLongTaskMs), loadLongTaskMax: Math.round(v.loadLongTaskMax),
    mbTotal: v.mbTotal, byType: v.byType, backend: v.budget.backend, textures: v.budget.textures, textureMB: v.budget.textureMB,
    homeDraws: homeStats.drawCalls, selDraws: selStats.drawCalls, selTris: selStats.triangles, loadTimes: v.stats.loadTimes,
    gateIdle, enter, sel, orbit, overview, pan, errors: errors.slice(0, 5)
  });
  console.log(`run ${r}: hero ${Math.round(v.heroMs)}ms all ${Math.round(v.allMs)}ms tbt ${Math.round(v.tbt)} orbit p95 ${orbit.p95} errors ${errors.length}`);
  await browser.close();
}
const agg = k => ({ p50: pick(runs.map(x => x[k]), .5, k === 'cls' ? 3 : 1), p95: pick(runs.map(x => x[k]), .95, k === 'cls' ? 3 : 1) });
const fr = k => ({ p50: pick(runs.map(x => x[k].p50), .5), p95: pick(runs.map(x => x[k].p95), .5), p99: pick(runs.map(x => x[k].p99), .5), max: pick(runs.map(x => x[k].max), .95) });
const summary = {
  label: LABEL, url: URL_, runs: RUNS, date: new Date().toISOString(), backend: runs[0].backend,
  vitals: { ttfb: agg('ttfb'), fcp: agg('fcp'), lcp: agg('lcp'), cls: agg('cls'), inp: agg('inp'), tbt: agg('tbt') },
  loading: { heroMs: agg('heroMs'), allMs: agg('allMs'), loadLongTaskMs: agg('loadLongTaskMs'), loadLongTaskMax: agg('loadLongTaskMax') },
  payload: { mbTotal: runs[0].mbTotal, byType: runs[0].byType, textures: runs[0].textures, textureMB: runs[0].textureMB },
  draws: { home: runs[0].homeDraws, selected: runs[0].selDraws, selectedTris: runs[0].selTris },
  frames: { gateIdle: fr('gateIdle'), enter: fr('enter'), select: fr('sel'), orbit: fr('orbit'), overview: fr('overview'), pan: fr('pan') },
  errors: [...new Set(runs.flatMap(x => x.errors))]
};
console.log('SUMMARY', JSON.stringify(summary, null, 1));
if (OUT) writeFileSync(OUT, JSON.stringify({ summary, runs }, null, 1));
console.log('DONE');
