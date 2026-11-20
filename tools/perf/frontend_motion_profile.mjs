#!/usr/bin/env node
// Measure frame pacing AND camera motion, not just average FPS.
// Usage: QA_BACKEND=webgl|webgpu node tools/perf/frontend_motion_profile.mjs
// Run baseline/candidate on the same machine, GPU, profile and cache conditions.
import puppeteer from 'puppeteer-core';

const backend = process.env.QA_BACKEND || 'webgl';
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8090';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--enable-unsafe-webgpu', '--window-size=1440,900']
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${origin}/index.html?nointro&backend=${backend}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.initialReady, { timeout: 90000 });
  // Keep a hot GLB on GPU before profiling; this isolates motion from cold decoding.
  await page.waitForFunction(() => window.__VELANCE_QA__.engine.cars.has(window.__VELANCE_QA__.focus), { timeout: 45000 });
  await page.evaluate(() => {
    window.__motionFrames = [];
    window.__profileMotion = true;
    const tick = (now) => {
      if (!window.__profileMotion) return;
      const e = window.__VELANCE_QA__?.engine;
      if (e?.flight?.selection) {
        const c = e.camera;
        const car = e.cars.get(e.selected);
        const p = car?.position.clone().add({ x: 0, y: .8, z: 0 }).project(c);
        window.__motionFrames.push({
          at: now, t: e.flight.t, elapsed: e.flight.elapsed,
          pos: [c.position.x, c.position.y, c.position.z],
          quaternion: [c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w],
          projected: p ? [p.x, p.y] : null,
          reflect: e.reflectOn,
          renderMs: e.frameTimes[e.frameTimes.length - 1] || 0,
          drawCalls: e.lastDrawCalls,
          reflectorDraws: e.reflectorDraws
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.click('#selectCar');
  await page.waitForFunction(() => window.__VELANCE_QA__.engine.flight?.selection, { timeout: 15000 });
  await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight && window.__VELANCE_QA__.engine.controls?.enabled, { timeout: 60000 });
  const frames = await page.evaluate(() => {
    window.__profileMotion = false;
    return window.__motionFrames;
  });
  const percentile = (values, p) => {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))] || 0;
  };
  const delta = frames.slice(1).map((f, i) => {
    const a = frames[i], d = (f.at - a.at) / 1000;
    const step = Math.hypot(...f.pos.map((v, j) => v - a.pos[j]));
    const quatDot = Math.min(1, Math.abs(f.quaternion.reduce((sum, v, j) => sum + v * a.quaternion[j], 0)));
    const angle = Math.acos(quatDot) * 2;
    return {
      gapMs: d * 1000, linearSpeed: step / d, angularSpeed: angle / d,
      projectionStep: f.projected && a.projected ? Math.hypot(f.projected[0] - a.projected[0], f.projected[1] - a.projected[1]) : 0,
      projectionSpeed: f.projected && a.projected ? Math.hypot(f.projected[0] - a.projected[0], f.projected[1] - a.projected[1]) / d : 0,
      time: f.t, reflect: f.reflect
    };
  }).filter(x => Number.isFinite(x.linearSpeed) && x.gapMs > 0);
  const report = {
    backend, samples: frames.length, durationS: frames.length ? (frames.at(-1).at - frames[0].at) / 1000 : null,
    gapMs: { p50: percentile(delta.map(x => x.gapMs), .5), p95: percentile(delta.map(x => x.gapMs), .95), p99: percentile(delta.map(x => x.gapMs), .99), max: Math.max(...delta.map(x => x.gapMs)) },
    linearSpeedMax: Math.max(...delta.map(x => x.linearSpeed)),
    angularSpeedMax: Math.max(...delta.map(x => x.angularSpeed)),
    projectedSpeedMax: Math.max(...delta.map(x => x.projectionSpeed)),
    projectedStepMax: Math.max(...delta.map(x => x.projectionStep)),
    reflectorActiveFrames: frames.filter(x => x.reflect).length,
    renderMsMax: Math.max(...frames.map(x => x.renderMs)),
    slowest: delta.sort((a, b) => b.gapMs - a.gapMs).slice(0, 8),
    errors
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
