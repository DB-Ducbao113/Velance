#!/usr/bin/env node
// Real browser smoke for the selected-car hero flight. No permanent artifacts.
// Usage: QA_BACKEND=webgl|webgpu QA_MOBILE=1 QA_SHOT_DIR=... node ...
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const backend = process.env.QA_BACKEND || 'webgl';
const mobile = process.env.QA_MOBILE === '1';
const rear = process.env.QA_ROW === 'rear';
const overview = process.env.QA_FROM_OVERVIEW === '1';
const shots = process.env.QA_SHOT_DIR;
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8090';
if (shots) mkdirSync(shots, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--enable-unsafe-webgpu', '--window-size=1440,900']
});
try {
  const page = await browser.newPage();
  await page.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${origin}/index.html?nointro&backend=${backend}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.initialReady, { timeout: 90000 });
  if (rear) {
    await page.click('#rowBtn');
    await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight, { timeout: 45000 });
    assert.equal(await page.evaluate(() => window.__VELANCE_QA__.row), 1);
    await page.waitForFunction(() => window.__VELANCE_QA__.engine.cars.has(window.__VELANCE_QA__.focus), { timeout: 45000 });
  }
  if (overview) {
    await page.click('#overviewBtn');
    await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight, { timeout: 45000 });
  }
  await page.evaluate(() => {
    window.__selectionSamples = [];
    window.__recordSelection = true;
    const sample = () => {
      if (!window.__recordSelection) return;
      const e = window.__VELANCE_QA__?.engine;
      if (e?.selected !== null && e?.selected !== undefined) {
        const point = e.keyShadow.target.position.clone().project(e.camera);
        const matrix = e.camera.projectionMatrix.elements;
        window.__selectionSamples.push({
          t: e.flight?.selection ? e.flight.t : null,
          enabled: !!e.controls?.enabled,
          x: point.x, y: point.y, projection: Array.from(matrix),
          pos: [e.camera.position.x, e.camera.position.y, e.camera.position.z],
          mirror: !!e.refl && e.reflectOn,
          time: performance.now()
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  if (overview) {
    await page.evaluate(() => {
      const e = window.__VELANCE_QA__.engine;
      e.onSelect(e.focus);
    });
  } else await page.click('#selectCar');
  await page.waitForFunction(() => window.__VELANCE_QA__.engine.flight?.selection, { timeout: 10000 });
  assert.equal(await page.evaluate(() => document.getElementById('selectedView').getAttribute('aria-hidden')), 'true');
  for (const [step, threshold] of [['begin', .19], ['highlight', .59], ['reveal', .84]]) {
    await page.waitForFunction(threshold => window.__VELANCE_QA__.engine.flight?.t >= threshold, { timeout: 45000 }, threshold);
    if (shots) await page.screenshot({ path: join(shots, `selection-${backend}-${mobile ? 'mobile' : 'desktop'}-${step}.png`) });
  }
  await page.waitForFunction(() => window.__VELANCE_QA__.engine.controls?.enabled, { timeout: 45000 });
  await new Promise(resolve => setTimeout(resolve, 160));
  const result = await page.evaluate(() => {
    window.__recordSelection = false;
    const e = window.__VELANCE_QA__.engine;
    const samples = window.__selectionSamples;
    const lastBefore = [...samples].reverse().find(v => v.enabled === false && v.t !== null && v.t >= .985);
    const firstAfter = samples.find(v => v.enabled === true);
    const panel = document.getElementById('selectedView');
    const distance = lastBefore && firstAfter ? Math.hypot(firstAfter.x - lastBefore.x, firstAfter.y - lastBefore.y) : null;
    const matrixDistance = lastBefore && firstAfter
      ? Math.max(...firstAfter.projection.map((v, i) => Math.abs(v - lastBefore.projection[i]))) : null;
    const gaps = samples.slice(1).map((v, i) => v.time - samples[i].time)
      .filter((v, i) => v > 0 && samples[i + 1].t !== null).sort((a, b) => a - b);
    const during = samples.filter(v => v.t !== null);
    const cameraSteps = during.slice(1).map((v, i) =>
      Math.hypot(...v.pos.map((n, axis) => n - during[i].pos[axis])));
    return {
      backend: e.backend, selected: e.selected, enabled: e.controls.enabled,
      sampleCount: samples.length, distance, matrixDistance,
      frameGapP95: gaps[Math.floor(gaps.length * .95)] || null,
      mirrorFramesDuringFlight: during.filter(v => v.mirror).length,
      maxCameraStep: Math.max(0, ...cameraSteps),
      final: { x: firstAfter?.x, y: firstAfter?.y },
      css: { panelOpacity: getComputedStyle(panel).opacity, titleOpacity: getComputedStyle(document.getElementById('selectionCinema')).opacity },
      reviewCount: document.querySelectorAll('.shot-section').length,
      boardCount: document.querySelectorAll('.board-item').length,
      pageOverflow: document.documentElement.scrollWidth > innerWidth
    };
  });
  assert.equal(result.backend, backend === 'webgl' ? 'webgl2' : 'webgpu');
  assert(result.sampleCount > 40 && result.distance !== null, 'must measure samples on both sides of orbit handoff');
  assert(result.distance < .035, `image of selected car jumped at handoff: ${JSON.stringify(result)}`);
  assert(result.matrixDistance < .04, `projection matrix jumped at handoff: ${JSON.stringify(result)}`);
  assert.equal(result.css.panelOpacity, '1');
  assert.equal(result.reviewCount, 0);
  assert(result.boardCount > 0);
  assert.equal(result.pageOverflow, false);
  assert(result.frameGapP95 > 0 && Number.isFinite(result.frameGapP95));
  assert.equal(result.mirrorFramesDuringFlight, 0, 'no expensive floor-reflection passes during the moving shot');
  assert(result.maxCameraStep < .4, `camera jumped between frames: ${JSON.stringify(result)}`);
  if (shots) await page.screenshot({ path: join(shots, `selection-${backend}-${mobile ? 'mobile' : 'desktop'}-landed.png`) });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__VELANCE_QA__.selected === null && !window.__VELANCE_QA__.engine.flight, { timeout: 45000 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.initialReady, { timeout: 90000 });
  await page.click('#selectCar');
  await page.waitForFunction(() => window.__VELANCE_QA__.engine.controls?.enabled, { timeout: 10000 });
  assert.equal(await page.evaluate(() => window.__VELANCE_QA__.engine.flight), null);
  assert.deepEqual(errors, []);
  console.log(`PASS ${backend} ${mobile ? 'mobile' : 'desktop'} ${rear ? 'rear' : 'front'} ${overview ? 'overview' : 'home'}: selected cinematic, continuity ndc=${result.distance.toFixed(4)}, matrix=${result.matrixDistance.toFixed(4)}, frameGapP95=${result.frameGapP95.toFixed(1)}ms, title/spec panel, return, reduced motion`);
} finally {
  await browser.close();
}
