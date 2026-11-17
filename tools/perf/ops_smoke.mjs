import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createOpsServer } from '../ops/server.mjs';

const root = resolve(import.meta.dirname, '../..');
const temp = mkdtempSync(join(tmpdir(), 'velance-ops-'));
const shots = process.env.QA_SHOTS || join(temp, 'shots');
mkdirSync(shots, { recursive: true });
const server = await createOpsServer({ root, dbPath: join(temp, 'qa.db') });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--window-size=1440,900'], ignoreDefaultArgs: ['--disable-back-forward-cache'] });
const evidence = { date: new Date().toISOString(), journeys: [], checks: [] };
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async path => { const r = await fetch(origin + path); assert(r.ok); return r.json(); };
const check = message => { evidence.checks.push(message); console.log('PASS', message); };
async function page() {
  const p = await browser.newPage(); await p.setViewport({ width: 1440, height: 900 }); await p.bringToFront();
  return p;
}
async function idle(p) { await p.waitForFunction(() => !window.__VELANCE_QA__.engine.flight); }
async function gesture(p, selected = false) {
  const start = selected ? 600 : 1000;
  await p.mouse.move(start, 570); await p.mouse.down();
  for (let i = 0; i < 18; i++) { await p.mouse.move(start - i * (selected ? 9 : 35), 570 + (selected ? i * 2 : 0)); await wait(90); }
  await p.mouse.up(); await wait(350);
}
let python;
try {
  const empty = await page(); await empty.goto(origin + '/ops/'); await empty.waitForFunction(() => document.querySelector('#updatedAt').textContent.startsWith('live'));
  assert.match(await empty.$eval('#sessionRows', e => e.textContent), /No sessions/); await empty.screenshot({ path: join(shots, 'ops-empty.png') }); await empty.close();
  for (const backend of ['webgpu', 'webgl']) {
    const p = await page(), errors = [], posts = [];
    p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    p.on('response', r => { if (r.url().endsWith('/api/telemetry')) posts.push(r.status()); });
    await p.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.__loadObserved = null;
      const timer = setInterval(() => { if (window.__VELANCE_QA__?.stats()?.loaded === 16) { window.__loadObserved = performance.now(); clearInterval(timer); } }, 10);
    });
    await p.goto(`${origin}/index.html?backend=${backend}`, { waitUntil: 'load' });
    await p.waitForFunction(() => Number(getComputedStyle(document.querySelector('#gateEnter')).opacity) > .99);
    await p.screenshot({ path: join(shots, `${backend}-gate.png`) });
    await p.waitForFunction(() => window.__VELANCE_TELEMETRY__?.milestones.allLoaded != null, { timeout: 120000 });
    const initial = await p.evaluate(() => ({ session: window.__VELANCE_TELEMETRY__.session, m: window.__VELANCE_TELEMETRY__.milestones, observed: window.__loadObserved,
      engineStart: window.__VELANCE_QA__.engine.t0, firstFrameMs: window.__VELANCE_QA__.stats().firstFrameMs, backend: window.__VELANCE_QA__.stats().backend }));
    const clockOrigin = initial.engineStart + initial.firstFrameMs - initial.m.firstFrame;
    const delta = Math.abs(initial.m.allLoaded - (initial.observed - clockOrigin));
    assert(delta <= 300, `allLoaded observer delta ${delta}ms`); assert.equal(initial.backend, backend === 'webgl' ? 'webgl2' : 'webgpu');
    await p.click('#gateEnter'); await p.waitForFunction(() => !document.getElementById('gate')); await idle(p); await wait(1200);
    await p.screenshot({ path: join(shots, `${backend}-home.png`) });
    await gesture(p); await idle(p); await p.click('#selectCar');
    await p.waitForFunction(() => window.__VELANCE_QA__.engine.controls?.enabled && Number(getComputedStyle(document.querySelector('.selected-view')).opacity) > .99);
    await gesture(p, true); await p.click('[data-finish="rosso"]'); await p.click('[data-finish="original"]');
    await p.waitForFunction(() => performance.now() - window.__VELANCE_QA__.engine.lastOrbitAt > 200);
    await p.screenshot({ path: join(shots, `${backend}-selected.png`) }); await wait(1200);
    await p.click('#backToGarageTop'); await idle(p); await p.click('#overviewBtn'); await idle(p); await wait(1200);
    await p.screenshot({ path: join(shots, `${backend}-overview.png`) });
    await p.keyboard.press('Escape'); await idle(p); await p.click('#rowBtn'); await idle(p); await wait(1200);
    await p.evaluate(() => window.__VELANCE_TELEMETRY__.flush());
    const session = await get(`/api/sessions/${initial.session}`);
    assert.equal(session.backend, initial.backend); assert.equal(session.final.stats.loaded, 16); assert.equal(Object.keys(session.final.stats.loadTimes).length, 16);
    assert(session.milestones.firstCar < session.milestones.enter);
    for (const phase of ['browse', 'selected-orbit', 'selected-idle', 'overview', 'home-idle']) assert(session.samples.some(s => s.phase === phase), `${backend} missing ${phase}`);
    assert(session.samples.filter(s => s.phase.endsWith('idle')).every(s => s.fps === null));
    for (const type of ['selectCar', 'paint', 'overviewBtn', 'rowBtn', 'backToGarageTop']) assert(session.events.some(e => e.type === type), `missing event ${type}`);
    const priorSeq = session.last_seq;
    const cover = await page(); await cover.goto(origin + '/ops/'); await p.waitForFunction(() => document.hidden);
    await wait(300); assert((await get(`/api/sessions/${initial.session}`)).last_seq > priorSeq, 'Hidden beacon not received');
    await p.bringToFront(); await p.waitForFunction(() => !document.hidden); await wait(1200); await p.evaluate(() => window.__VELANCE_TELEMETRY__.flush());
    assert((await get(`/api/sessions/${initial.session}`)).samples.length > session.samples.length); await cover.close();
    const beforeNav = (await get(`/api/sessions/${initial.session}`)).last_seq;
    await p.goto(origin + '/ops/'); await wait(300); assert((await get(`/api/sessions/${initial.session}`)).last_seq > beforeNav, 'Navigation checkpoint not received');
    assert(posts.length && posts.every(s => s === 200), `telemetry status ${posts}`); assert.deepEqual(errors, []);
    evidence.journeys.push({ backend: initial.backend, allLoadedMs: initial.m.allLoaded, observerMs: +(initial.observed - clockOrigin).toFixed(2), deltaMs: +delta.toFixed(2), samples: session.samples.length, events: session.events.length, consoleErrors: errors.length });
    check(`${backend}: real journey, idle unknown, hidden resume and received navigation checkpoint`); await p.close();
  }

  for (const storage of [false, true]) {
    const p = await page(), requests = [];
    if (storage) await p.evaluateOnNewDocument(() => localStorage.setItem('velance_telemetry_off', '1'));
    p.on('request', r => { if (r.method() === 'HEAD' || r.url().includes('/api/')) requests.push(r.url()); });
    await p.goto(origin + '/index.html?' + (storage ? 'nointro' : 'notelemetry&nointro')); await p.waitForFunction(() => window.__VELANCE_TELEMETRY__);
    assert.equal(await p.evaluate(() => window.__VELANCE_TELEMETRY__.enabled), false); assert.equal(await p.evaluate(() => window.__VELANCE_TELEMETRY__.session), null);
    assert.deepEqual(requests, []); await p.close();
  }
  const clear = await page(); await clear.goto(origin + '/ops/'); await clear.evaluate(() => localStorage.removeItem('velance_telemetry_off')); await clear.close();
  check('query and localStorage opt-out produce no collector request');

  python = spawn('python3', ['-u', '-c', 'import http.server\ns=http.server.ThreadingHTTPServer(("127.0.0.1",0),http.server.SimpleHTTPRequestHandler)\nprint(s.server_port,flush=True)\ns.serve_forever()'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  const pythonPort = await new Promise((ok, no) => { python.once('error', no); python.stdout.once('data', d => ok(Number(d.toString().trim()))); });
  const plain = await page(), plainRequests = [];
  plain.on('request', r => { if (r.method() === 'HEAD' || r.url().includes('/api/')) plainRequests.push(r.method()); });
  await plain.goto(`http://127.0.0.1:${pythonPort}/index.html?nointro`); await plain.waitForFunction(() => window.__VELANCE_TELEMETRY__); await wait(500);
  assert.equal(await plain.evaluate(() => window.__VELANCE_TELEMETRY__.enabled), false); assert.deepEqual(plainRequests, ['HEAD']); await plain.close(); python.kill(); python = null;
  check('plain Python static server is HEAD-only');

  const lifecycle = await page();
  await lifecycle.setRequestInterception(true);
  lifecycle.on('request', r => {
    if (r.url().includes('/src/ui/app.js')) void r.respond({ status: 200, contentType: 'text/javascript', body: 'window.__VELANCE_QA__ = { fallback:true, engineError:"test unavailable", stats:()=>null };' });
    else void r.continue();
  });
  await lifecycle.evaluateOnNewDocument(() => window.addEventListener('pageshow', e => { window.__persisted = e.persisted; }));
  await lifecycle.goto(origin + '/index.html?nointro'); await lifecycle.waitForFunction(() => window.__VELANCE_TELEMETRY__?.enabled); await wait(300);
  const bfcacheId = await lifecycle.evaluate(() => window.__VELANCE_TELEMETRY__.session);
  await lifecycle.evaluate(() => window.__VELANCE_TELEMETRY__.flush());
  assert.equal((await get(`/api/sessions/${bfcacheId}`)).milestones.allLoaded, null);
  await lifecycle.goto(origin + '/ops/'); await lifecycle.goBack({ waitUntil: 'load' });
  await lifecycle.waitForFunction(() => window.__persisted === true, { timeout: 10000 });
  assert.equal(await lifecycle.evaluate(() => window.__VELANCE_TELEMETRY__.session), bfcacheId);
  assert.equal(await lifecycle.evaluate(() => window.__VELANCE_TELEMETRY__.enabled), true); await lifecycle.close();
  check('real Chrome BFCache pageshow.persisted preserves collector session (image-fallback fixture)');

  const failure = await page(); let attempted = 0; const rejection = [];
  await failure.setRequestInterception(true);
  failure.on('pageerror', e => rejection.push(e.message));
  failure.on('request', r => {
    if (r.url().endsWith('/api/telemetry')) { attempted++; void r.abort('failed'); }
    else if (r.url().endsWith('/src/ui/app.js')) void r.respond({ status: 200, contentType: 'text/javascript', body: '' });
    else void r.continue();
  });
  await failure.goto(origin + '/index.html?nointro'); await failure.waitForFunction(() => window.__VELANCE_TELEMETRY__?.enabled);
  await failure.evaluate(() => window.__VELANCE_TELEMETRY__.flush());
  assert.equal(await failure.evaluate(() => window.__VELANCE_TELEMETRY__.enabled), false);
  await failure.evaluate(() => window.__VELANCE_TELEMETRY__.flush()); assert.equal(attempted, 1); assert.deepEqual(rejection, []); await failure.close();
  check('intentional transport failure disables without retry or unhandled rejection');

  for (const [i, milestones] of [{ firstFrame: 0, firstCar: 0, allLoaded: 0, enter: 0 }, { firstCar: 100, allLoaded: 200, enter: 900 }, { firstCar: 50 }].entries()) {
    const res = await fetch(origin + '/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: `fixture-${i}`, seq: 0, startedAt: Date.now() + i, backend: i === 2 ? 'images' : 'webgpu', milestones, samples: [60, null, 50].map((fps, t) => ({ t, phase: 'browse', fps })), events: [{ t: 1, type: 'error', data: { msg: '<img src=x onerror="window.__xss=1">' } }] }) }); assert.equal(res.status, 200);
  }
  const dash = await page(), dashErrors = [];
  dash.on('pageerror', e => dashErrors.push(e.message)); dash.on('console', m => { if (m.type() === 'error') dashErrors.push(m.text()); });
  await dash.goto(origin + '/ops/'); await dash.waitForSelector('[data-id="fixture-1"]'); await dash.screenshot({ path: join(shots, 'ops-desktop.png') });
  await dash.click('[data-id="fixture-1"]'); await dash.waitForFunction(() => !document.querySelector('#drill').hidden); await wait(500);
  assert(await dash.$$eval('#drillWaterfall i', els => els.every(e => Number.isFinite(parseFloat(e.style.width)) && parseFloat(e.style.width) <= 100)));
  assert.equal(await dash.$eval('#drillSpark path', e => (e.getAttribute('d').match(/M/g) || []).length), 2);
  assert.equal(await dash.$('#drillEvents img'), null); assert.equal(await dash.evaluate(() => window.__xss), undefined);
  await dash.screenshot({ path: join(shots, 'ops-drill.png') });
  await dash.evaluate(() => { window.__scrollCalls = 0; document.querySelector('#drill').scrollIntoView = () => window.__scrollCalls++; window.scrollTo(0, 0); });
  await wait(5400); assert.equal(await dash.evaluate(() => window.__scrollCalls), 0);
  await dash.click('[data-id="fixture-0"]'); await wait(200); assert(await dash.$$eval('#drillWaterfall i', es => es.every(e => parseFloat(e.style.width) === 0)));
  const delayed = [];
  await dash.setRequestInterception(true);
  dash.on('request', r => { if (r.url().includes('/api/sessions/fixture-1')) delayed.push(r); else void r.continue(); });
  await dash.click('[data-id="fixture-1"]'); await wait(100); await dash.click('#drillClose');
  for (const r of delayed.splice(0)) await r.continue().catch(() => {});
  await wait(200); assert.equal(await dash.$eval('#drill', e => e.hidden), true);
  await dash.click('[data-id="fixture-1"]'); await wait(100); await dash.click('[data-id="fixture-2"]'); await wait(200);
  for (const r of delayed.splice(0)) await r.continue().catch(() => {});
  await wait(200); assert.match(await dash.$eval('#drillContext', e => e.textContent), /images$/);
  await dash.setRequestInterception(false); await dash.setViewport({ width: 390, height: 844 });
  await dash.evaluate(() => window.scrollTo(0, 0)); await dash.screenshot({ path: join(shots, 'ops-mobile.png') });
  await dash.evaluate(() => document.querySelector('#drill').scrollIntoView = Element.prototype.scrollIntoView);
  await dash.$eval('#drill', e => e.scrollIntoView()); await dash.screenshot({ path: join(shots, 'ops-mobile-drill.png') });
  assert(await dash.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(dashErrors, []);
  check('dashboard empty/partial/zero/late-enter/null, escaping, refresh scroll, close/switch races and mobile');
  await dash.close();

  const errorDash = await page(); await errorDash.setRequestInterception(true);
  errorDash.on('request', r => r.url().includes('/api/') ? void r.respond({ status: 500, contentType: 'application/json', body: '{"error":"test"}' }) : void r.continue());
  await errorDash.goto(origin + '/ops/'); await errorDash.waitForFunction(() => document.querySelector('#updatedAt').textContent === 'ops server unreachable'); await errorDash.close();
  check('dashboard handles API failure');

  const render = await page(); const renderErrors = []; render.on('pageerror', e => renderErrors.push(e.message));
  await render.goto(origin + '/tools/render/render.html'); await render.waitForFunction(() => window.__ready === true, { timeout: 60000 });
  const sizes = await render.evaluate(async () => {
    const { VEHICLES } = await import('/src/data/vehicles.js');
    const car = VEHICLES.find(v => v.id === 'senna'); return (await window.__shoot(car.file, car.axis || 'z', false)).map(([name, data]) => ({ name, bytes: data.length }));
  }); assert.equal(sizes.length, 5); assert(sizes.every(s => s.bytes > 100000)); assert.deepEqual(renderErrors, []); await render.close();
  check('render harness renders five poses without writing model/image assets');
  writeFileSync(join(shots, 'ops-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(`Evidence: ${shots}`);
} finally {
  if (python) python.kill();
  await browser.close(); await new Promise(r => server.close(r));
  if (process.env.QA_SHOTS) rmSync(temp, { recursive: true, force: true });
  else console.log(`Retained local QA evidence: ${temp}`);
}
