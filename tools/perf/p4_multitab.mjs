// Four independent cold-cache tabs in ONE local Chrome (NOT four real devices).
// A distinct bounded 100-client HTTP test covers virtual user concurrency.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, cpus, platform, arch } from 'node:os';
import puppeteer from 'puppeteer-core';
import { createSnapshot, activateRelease } from '../delivery/release.mjs';
import { createDeliveryServer } from '../delivery/server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
function value(name, def) { const i = argv.indexOf(name); return i < 0 ? def : argv[i + 1]; }
for (let i = 0; i < argv.length; i += 2) {
  assert(['--tabs', '--backend', '--out', '--max-seconds'].includes(argv[i]) && argv[i + 1]
    && !argv[i + 1].startsWith('--'), 'Unsupported argument ' + argv[i]);
}
const tabs = Number(value('--tabs', '4'));
const backend = value('--backend', 'webgpu');
const maxSeconds = Number(value('--max-seconds', '90'));
const out = resolve(ROOT, value('--out', 'tools/perf/results/p4-multitab-webgpu-4.json'));
assert(Number.isInteger(tabs) && tabs >= 1 && tabs <= 4, 'tabs must be 1..4');
assert(['webgpu', 'webgl'].includes(backend), 'backend must be webgpu or webgl');
assert(Number.isInteger(maxSeconds) && maxSeconds >= 15 && maxSeconds <= 120, 'timeout must be 15..120 seconds');
const temp = mkdtempSync(join(tmpdir(), 'velance-p4-multitab-'));
let browser, server;
try {
  const storeDir = join(temp, 'store');
  const snapshot = await createSnapshot({ sourceRoot: ROOT, storeDir });
  await activateRelease({ storeDir, id: snapshot.id });
  server = createDeliveryServer({ storeDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const url = base + '/r/' + snapshot.id + '/index.html?nointro&notelemetry&backend=' + backend;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false, args: ['--enable-unsafe-webgpu', '--window-size=1440,900'] });
  const ctxs = await Promise.all(Array.from({ length: tabs }, () => browser.createBrowserContext()));
  const visitor = async (context, i) => {
    const page = await context.newPage();
    const failures = [], statuses = {}, readyTime = performance.now();
    let transferBytes = 0, networkFiles = 0, fromCache = 0;
    page.on('error', e => failures.push('page-crash:' + e.message));
    page.on('pageerror', e => failures.push('pageerror:' + e.message));
    page.on('console', e => { if (e.type() === 'error') failures.push('console:' + e.text().slice(0, 240)); });
    page.on('response', response => {
      const status = response.status();
      statuses[status] = (statuses[status] || 0) + 1;
      if (status >= 400) failures.push('HTTP' + status + ':' + response.url().slice(0, 180));
    });
    await page.setViewport({ width: 1440, height: 900 });
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.loadingFinished', event => {
      transferBytes += event.encodedDataLength || 0;
      networkFiles++;
    });
    cdp.on('Network.requestServedFromCache', () => { fromCache++; });
    let loadMs = null, state = null, heapBytes = null, stage = 'navigation';
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: maxSeconds * 1000 });
      stage = 'load16';
      await page.waitForFunction(() => window.__VELANCE_QA__?.stats?.()?.loaded === 16
        || window.__VELANCE_QA__?.fallback === true, { timeout: maxSeconds * 1000 });
      loadMs = performance.now() - readyTime;
      state = await page.evaluate(() => {
        const qa = window.__VELANCE_QA__, stats = qa.stats();
        return { backend: stats.backend, loaded: stats.loaded, bays: stats.bays,
          fallback: qa.fallback, engineReady: !!qa.engine,
          telemetryEnabled: window.__VELANCE_TELEMETRY__?.enabled ?? false };
      });
      const metrics = await page.metrics();
      heapBytes = metrics.JSHeapUsedSize ?? null;
      stage = 'enter-overview';
      await page.click('#overviewBtn');
      await page.waitForFunction(() => !window.__VELANCE_QA__?.engine?.flight, { timeout: 30000 });
      // Overview hides the regular car-selection navigation; return to the home
      // view before selecting a machine, matching the established GPU QA journey.
      stage = 'exit-overview';
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.__VELANCE_QA__?.engine?.flight
        && window.__VELANCE_QA__?.overview === false, { timeout: 30000 });
      stage = 'select-car';
      await page.click('#selectCar');
      await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.controls?.enabled,
        { timeout: 30000 });
      const selected = await page.evaluate(() => window.__VELANCE_QA__?.selected);
      if (selected == null) failures.push('No selected vehicle after overview/selected journey');
    } catch (e) { failures.push(stage + ': ' + String(e?.message || e).slice(0, 300)); }
    return { visitorIndex: i, loadMs, state, heapBytes, statuses, networkFiles,
      fromCache, transferBytes, failures, completed: failures.length === 0 };
  };
  const wallStart = performance.now();
  const visitors = await Promise.all(ctxs.map(visitor));
  const elapsedMs = performance.now() - wallStart;
  const expected = backend === 'webgl' ? 'webgl2' : 'webgpu';
  const gates = { noErrors: visitors.every(v => v.failures.length === 0),
    allLoaded16: visitors.every(v => v.state?.loaded === 16 && v.state?.bays === 16),
    requestedBackend: visitors.every(v => v.state?.backend === expected && !v.state?.fallback),
    allVisitorsCompleted: visitors.every(v => v.completed),
    telemetryOptedOut: visitors.every(v => v.state?.telemetryEnabled === false) };
  const report = { format: 'velance-p4-real-multitab/1', measuredAtUtc: new Date().toISOString(),
    environment: { node: process.version, chrome: await browser.version(),
      cpu: cpus()[0]?.model, platform: platform(), arch: arch() },
    profile: { tabs, backend: expected, viewport: '1440x900', perVisitorBrowserContext: true,
      coldCache: true, maxSeconds, showroom: 'all 16 GLB, then overview and selected car',
      localOnly: true, distinctRealDevices: 0, distinctTabs: tabs },
    release: { id: snapshot.id, totalFiles: snapshot.manifest.files.length }, elapsedMs,
    totalTransferBytes: visitors.reduce((n, v) => n + v.transferBytes, 0),
    visitors, gates, overall: Object.values(gates).every(Boolean) ? 'PASS_LOCAL' : 'FAIL_LOCAL',
    limitations: [
      'Independent tabs in ONE Chrome browser on one GPU, not independent devices, users, global CDN, or Internet traffic.',
      'Cache separated by browser contexts, GPU process and host CPU remain shared.',
      'No guarantee against session length, battery drain or production WebGPU availability.'
    ] };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ out, status: report.overall, elapsedMs,
    transfersMB: report.totalTransferBytes / 1e6,
    results: visitors.map(v => ({ i: v.visitorIndex, loaded: v.state?.loaded,
      backend: v.state?.backend, loadMs: Math.round(v.loadMs ?? -1),
      transferMB: +(v.transferBytes / 1e6).toFixed(2), heapMiB: v.heapBytes == null
        ? null : +(v.heapBytes / 1048576).toFixed(1), errors: v.failures })) }, null, 2));
  if (!Object.values(gates).every(Boolean)) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server?.listening) await server.shutdown();
  rmSync(temp, { recursive: true, force: true });
}
