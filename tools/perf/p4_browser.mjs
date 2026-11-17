// P4 matched-browser rendering performance on a disposable private Ops database
// and immutable delivery preview. One headed Chrome; no public deployment.
//
// node tools/perf/p4_browser.mjs --pairs 3 --backend both --profile loopback
// node tools/perf/p4_browser.mjs --pairs 3 --backend webgpu --profile constrained
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, arch, cpus, release } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createOpsServer } from '../ops/server.mjs';
import { createDeliveryServer } from '../delivery/server.mjs';
import { createSnapshot, activateRelease } from '../delivery/release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const pairs = Number(arg('--pairs', '3'));
const backendFlag = arg('--backend', 'webgpu');
const profile = arg('--profile', 'loopback');
const out = resolve(ROOT, arg('--out', 'tools/perf/results/p4-browser.json'));
assert(Number.isInteger(pairs) && pairs >= 1 && pairs <= 3, 'pairs must be 1..3');
assert(['webgpu', 'webgl', 'both'].includes(backendFlag), 'backend must be webgpu, webgl or both');
assert(['loopback', 'constrained'].includes(profile), 'profile must be loopback or constrained');
assert(argv.every((word, i) => !word.startsWith('--') || ['--pairs', '--backend', '--profile', '--out'].includes(word)), 'unknown arg');
const backends = backendFlag === 'both' ? ['webgpu', 'webgl'] : [backendFlag];
const delay = ms => new Promise(ok => setTimeout(ok, ms));
const median = values => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;

async function launch(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function capture(page, milliseconds = 1500) {
  return page.evaluate(async duration => new Promise(resolve => {
    const gaps = [];
    let start = null, previous = null;
    function frame(now) {
      if (start == null) start = now;
      if (previous != null) gaps.push(now - previous);
      previous = now;
      if (now - start < duration) { requestAnimationFrame(frame); return; }
      const sorted = [...gaps].sort((a, b) => a - b);
      const pick = percent => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(percent * sorted.length))] : null;
      const fixed = number => number == null ? null : +number.toFixed(2);
      resolve({ frames: gaps.length, avg: fixed(gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1)),
        p50: fixed(pick(.5)), p95: fixed(pick(.95)), p99: fixed(pick(.99)), max: fixed(pick(1)) });
    }
    requestAnimationFrame(frame);
  }), milliseconds);
}

async function drag(page) {
  const node = await page.$('#selectedModelHost');
  const box = await node?.boundingBox();
  if (!box) throw new Error('selected model host has no bounding box');
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 22; i++) {
    await page.mouse.move(x + 130 * Math.sin(i / 22 * Math.PI), y + 25 * Math.sin(i / 22 * Math.PI * 2));
    await delay(45);
  }
  await page.mouse.up();
}

const temp = mkdtempSync(join(tmpdir(), 'velance-p4-browser-'));
const storeDir = join(temp, 'private-releases');
const dbPath = join(temp, 'fixture.db');
let ops, preview, browser;
try {
  const snapshot = await createSnapshot({ sourceRoot: ROOT, storeDir });
  await activateRelease({ storeDir, id: snapshot.id });
  ops = await createOpsServer({ root: ROOT, dbPath });
  const opsPort = await launch(ops);
  preview = createDeliveryServer({ storeDir });
  const deliveryPort = await launch(preview);

  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false, args: ['--enable-unsafe-webgpu', '--window-size=1440,900']
  });
  const run = [];
  for (const backend of backends) for (let pair = 0; pair < pairs; pair++) {
    const order = pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const name of order) {
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.setCacheEnabled(true);
        const cdp = await page.createCDPSession();
        await cdp.send('Network.enable');
        if (profile === 'constrained') await cdp.send('Network.emulateNetworkConditions', {
          offline: false, latency: 40, downloadThroughput: 20_000_000 / 8, uploadThroughput: 5_000_000 / 8
        });
        const errors = [];
        page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 256)));
        page.on('console', e => { if (e.type() === 'error') errors.push(e.text().slice(0, 256)); });
        const base = name === 'baseline' ? `http://127.0.0.1:${opsPort}` : `http://127.0.0.1:${deliveryPort}`;
        const file = name === 'baseline' ? '/index.html' : `/r/${snapshot.id}/index.html`;
        const url = `${base}${file}?nointro&notelemetry&backend=${backend}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction(() => window.__VELANCE_QA__?.stats?.()?.loaded === 16, { timeout: 120000 });
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }); // explicitly warm
        await page.waitForFunction(() => window.__VELANCE_QA__?.stats?.()?.loaded === 16, { timeout: 120000 });
        const state = await page.evaluate(() => {
          const q = window.__VELANCE_QA__, stats = q.stats();
          return { backend: stats.backend, loaded: stats.loaded, bays: stats.bays,
            fallback: q.fallback, telemetryEnabled: window.__VELANCE_TELEMETRY__?.enabled };
        });
        assert.equal(state.backend, backend === 'webgl' ? 'webgl2' : 'webgpu');
        assert.equal(state.loaded, 16);
        assert.equal(state.bays, 16);
        assert.equal(state.fallback, false);
        assert.equal(state.telemetryEnabled, false);
        await delay(200);
        const home = await capture(page);
        await page.click('#overviewBtn');
        await page.waitForFunction(() => !window.__VELANCE_QA__?.engine?.flight, { timeout: 60000 });
        const overview = await capture(page);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !window.__VELANCE_QA__?.engine?.flight, { timeout: 60000 });
        await page.click('#selectCar');
        await page.waitForFunction(() => {
          const q = window.__VELANCE_QA__;
          return q?.engine?.controls?.enabled && Number(getComputedStyle(document.querySelector('.selected-view')).opacity) > .99;
        }, { timeout: 60000 });
        // Measure a fixed 1.5 second interval, including a matched 22-step user drag.
        const [orbit] = await Promise.all([capture(page, 1500), drag(page)]);
        const errorsBeforeClose = [...errors];
        const entry = { name, backend: state.backend, pair, order, profile,
          state, home, overview, orbit, errors: errorsBeforeClose };
        run.push(entry);
        console.log(JSON.stringify({ name, backend: state.backend, pair,
          home: home.avg, overview: overview.avg, orbit: orbit.avg, errors: errorsBeforeClose.length }));
      } finally {
        await context.close();
      }
    }
  }

  const verdicts = [];
  for (const backend of backends) {
    const actual = backend === 'webgl' ? 'webgl2' : backend;
    for (const stage of ['home', 'overview', 'orbit']) {
      const deltas = Array.from({ length: pairs }, (_, i) => {
        const candidate = run.find(r => r.backend === actual && r.name === 'candidate' && r.pair === i);
        const baseline = run.find(r => r.backend === actual && r.name === 'baseline' && r.pair === i);
        assert(candidate && baseline);
        return +(candidate[stage].avg - baseline[stage].avg).toFixed(2);
      });
      const pairedMedian = median(deltas);
      verdicts.push({ backend: actual, stage, deltasMs: deltas,
        pairedMedianDeltaMs: pairedMedian, criterion: 'median paired avg-frame-gap delta < 1.0 ms',
        passed: pairedMedian < 1 && run.filter(r => r.backend === actual).every(r => r.errors.length === 0) });
    }
  }
  const evidence = { format: 'velance-p4-browser/1', timestamp: new Date().toISOString(),
    environment: { node: process.version, chrome: await browser.version(), platform: platform(), arch: arch(),
      osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    settings: { backends, pairs, profile, headless: false,  browserCache: 'warm reload in fresh context per pair',
      telemetryOptedOut: true, localOnly: true, sourceAssetsUnchanged: true,
      testStages: ['home-idle after loaded16', 'overview idle', 'selected-orbit drag'] },
    release: { id: snapshot.id, files: snapshot.manifest.files.length },
    verdicts, cases: run,
    gates: { browserErrors: run.every(r => r.errors.length === 0),
      all16AndBackend: run.every(r => r.state.loaded === 16 && !r.state.fallback),
      frameDelta: verdicts.every(v => v.passed) },
    caveats: ['GPU-frame measurements are local-device paired samples, not CDN/network capacity.',
      'No exact visual pixel equivalence assertion, screenshot suite, real iPhone or full P4 fleet matrix here.'] };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[p4-browser] wrote ${out}, frameDelta=${evidence.gates.frameDelta ? 'PASS' : 'FAIL/MIXED'}`);
} finally {
  if (browser) await browser.close();
  if (preview?.listening) await preview.shutdown();
  if (ops) await ops.shutdown();
  rmSync(temp, { recursive: true, force: true });
}
