#!/usr/bin/env node
// Run with an HTTP server at :8090. Optional QA_BACKEND=webgpu / QA_SHOT=path.
// This is a manual GPU/browser smoke, intentionally outside the native test glob.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const backend = process.env.QA_BACKEND || 'webgl';
const mobile = process.env.QA_MOBILE === '1';
const throughGate = process.env.QA_GATE === '1';
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8090';
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: chrome, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--enable-webgl', '--window-size=1440,900']
});
try {
  const page = await browser.newPage();
  await page.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
  if (throughGate) {
    // The product intentionally hides the gate from automated probes.
    await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false }));
  }
  const errors = [];
  const requests = [];
  page.on('request', r => { if (r.url().includes('/assets/models/') && r.url().endsWith('.glb')) requests.push(r.url()); });
  const delayMs = Number(process.env.QA_DELAY_MS || 0);
  if (delayMs > 0) {
    await page.setRequestInterception(true);
    page.on('request', async r => {
      if (r.url().endsWith('/bugatti_tourbillon_2024.glb')) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (!r.isInterceptResolutionHandled()) await r.continue();
    });
  }
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${origin}/index.html?${throughGate ? '' : 'nointro&'}backend=${backend}`, { waitUntil: 'load', timeout: 30000 });
  if (!throughGate) await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.initialReady, { timeout: 90000 });
  if (!throughGate) assert.equal(requests.length, 1, 'direct gallery visits still load one car on demand');
  if (throughGate) {
    await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.entrancePrepared, { timeout: 90000 });
    assert(requests.length > 1, 'landing starts more than one transfer before ENTER');
  }

  const clickedAt = Date.now();
  await page.click(throughGate ? '#gateEnter' : '#lightShowBtn');
  await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.cinema, { timeout: 90000 });
  const early = await page.evaluate(() => {
    const e = window.__VELANCE_QA__.engine;
    return { cinema: e.cinema, overview: e.overview, fixtures: e.bayFixtures.length, initialCameraY: e.camera.position.y };
  });
  assert.equal(early.cinema, true);
  assert.equal(early.overview, true);
  assert.equal(early.fixtures, 16);
  assert(early.initialCameraY > 12, 'establishing shot must be above the hall');
  await page.evaluate(() => {
    const e = window.__VELANCE_QA__.engine;
    window.__revealViolations = [];
    const observe = () => {
      if (!e.cinema) return;
      for (let i = 0; i < 16; i++) {
        if (e.bayLightLevel(i) > 0 && (!e.cars.has(i) || !e.cars.get(i).visible)) window.__revealViolations.push(`lit bay ${i} missing real model`);
        if (e.placeholders.get(i)?.visible) window.__revealViolations.push(`placeholder visible in bay ${i}`);
      }
      requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
  });

  // A 400 ms main-thread stall must not advance the camera by 400 ms on resume.
  await page.waitForFunction(() => typeof window.__VELANCE_QA__.engine.flight?.elapsed === 'number');
  const { elapsedBeforeStall, elapsedAfterStall } = await page.evaluate(async () => {
    const e = window.__VELANCE_QA__.engine;
    const elapsedBeforeStall = e.flight.elapsed;
    const stop = performance.now() + 400;
    while (performance.now() < stop) { /* synthetic blocked frame */ }
    await new Promise(resolve => requestAnimationFrame(resolve));
    return { elapsedBeforeStall, elapsedAfterStall: e.flight.elapsed };
  });
  assert(elapsedAfterStall - elapsedBeforeStall < .085, `blocked frames must not skip camera choreography: before=${elapsedBeforeStall} after=${elapsedAfterStall}`);

  await page.waitForFunction(() => window.__VELANCE_QA__.engine.lightReveal?.elapsed > 1.3, { timeout: 30000 });
  const middle = await page.evaluate(() => {
    const e = window.__VELANCE_QA__.engine;
    return { first: e.bayLightLevel(0), last: e.bayLightLevel(15), firstFixture: e.bayFixtures[0].material.emissiveIntensity, lastFixture: e.bayFixtures[15].material.emissiveIntensity };
  });
  assert(middle.first > .9 && middle.last < .1, 'lights must reveal one bay at a time');
  assert(middle.firstFixture > middle.lastFixture + .5, 'fixture emissive intensity must follow the reveal');
  if (process.env.QA_SHOT) await page.screenshot({ path: process.env.QA_SHOT });

  await page.waitForFunction(() => window.__VELANCE_QA__.engine.lightReveal?.elapsed > 3.4, { timeout: 90000 });
  const lit = await page.evaluate(() => {
    const e = window.__VELANCE_QA__.engine;
    return Array.from({ length: 16 }, (_, i) => e.bayLightLevel(i));
  });
  assert(lit.every(value => value > .99), 'all sixteen bays must eventually illuminate');
  await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight, { timeout: 60000 });
  const finished = await page.evaluate(() => {
    const e = window.__VELANCE_QA__.engine;
    return { cinema: e.cinema, overview: e.overview, flight: !!e.flight, backend: e.backend, cameraY: e.camera.position.y, loaded: e.cars.size, violations: window.__revealViolations };
  });
  assert.equal(finished.cinema, false);
  assert.equal(finished.overview, throughGate);
  assert.equal(finished.loaded, 16);
  assert.deepEqual(finished.violations, []);
  console.log(JSON.stringify({ backend, mobile, throughGate, delayMs, enterToAllBaysMs: Date.now() - clickedAt, models: finished.loaded, uniqueRequests: new Set(requests).size, revealViolations: finished.violations.length }));
  assert.equal(finished.backend, backend === 'webgl' ? 'webgl2' : 'webgpu');
  assert(throughGate ? finished.cameraY > 12 : finished.cameraY < 4, 'first entrance stays wide; replay settles at car height');
  if (throughGate) {
    assert.equal(await page.$eval('#overviewBtn', el => el.disabled), false);
    await page.click('#overviewBtn');
    await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight, { timeout: 60000 });
  }
  await page.waitForFunction(() => Number(getComputedStyle(document.getElementById('overviewTitle')).opacity) < .02, { timeout: 4000 });
  if (process.env.QA_FINAL_SHOT) await page.screenshot({ path: process.env.QA_FINAL_SHOT });

  const movement = await page.evaluate(() => {
    const e = window.__VELANCE_QA__.engine;
    const original = e.position;
    e.setFocus(7);
    return original;
  });
  await new Promise(resolve => setTimeout(resolve, 125));
  const advanced = await page.evaluate(() => window.__VELANCE_QA__.engine.position);
  assert(Math.abs(advanced - movement) < .5, 'far bay request must not teleport the camera');
  const bounded = await page.evaluate(() => {
    const e = window.__VELANCE_QA__.engine;
    e.setFocus(7); e.position = 7; e.next();
    return e.target;
  });
  assert.equal(bounded, 7, 'next at the row boundary must not wrap');
  if (process.env.QA_JOURNEY === '1') {
    await page.click('#overviewBtn');
    await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.__VELANCE_QA__.overview), true);
    assert.equal(await page.evaluate(() => document.querySelector('#lightShowBtn').disabled), true);
    await page.click('#overviewBtn');
    await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight, { timeout: 60000 });
    await page.click('#rowBtn');
    await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.__VELANCE_QA__.row), 1);
    await page.click('#selectCar');
    await page.waitForFunction(() => window.__VELANCE_QA__.selected !== null && window.__VELANCE_QA__.engine.controls?.enabled, { timeout: 60000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__VELANCE_QA__.selected === null && !window.__VELANCE_QA__.engine.flight, { timeout: 60000 });
  }
  if (mobile) {
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile page must not overflow');
  }
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.initialReady, { timeout: 90000 });
  const reduced = await page.evaluate(() => {
    const e = window.__VELANCE_QA__.engine;
    return { reduced: e.reduced, played: e.entrance(), flight: !!e.flight, overview: e.overview };
  });
  assert.deepEqual(reduced, { reduced: true, played: false, flight: false, overview: false }, 'reduced-motion must skip cinematic flight');
  assert.deepEqual(errors, []);
  console.log(`PASS ${backend} ${mobile ? 'mobile' : 'desktop'}: 16 stepped lights, capped stalled frames, slow flight, bounded navigation, reduced motion`);
} finally {
  await browser.close();
}
