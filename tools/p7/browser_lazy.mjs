// P7 real headed Chrome / immutable snapshot. One browser reused for two backends.
// Does not open Ops/telemetry DB or publish assets to a network provider.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createDeliveryServer } from '../delivery/server.mjs';
import { createSnapshot, activateRelease } from '../delivery/release.mjs';

// Reuse the existing tools/perf browser dependency; P7 itself has no npm install.
const perfRequire = createRequire(new URL('../perf/package.json', import.meta.url));
const puppeteer = perfRequire('puppeteer-core');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
let out;
for (let i = 0; i < args.length; i += 2) {
  assert.equal(args[i], '--out', 'Expected optional --out new-report.json');
  out = resolve(ROOT, args[i + 1]);
}
if (out) assert(!existsSync(out), 'Refusing to overwrite browser evidence');
const browserPath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmp = mkdtempSync(join(tmpdir(), 'velance-p7-browser-'));
let browser, server;
const runs = [];
try {
  const storeDir = join(tmp, 'store');
  const release = await createSnapshot({ sourceRoot: ROOT, storeDir });
  await activateRelease({ storeDir, id: release.id });
  server = createDeliveryServer({ storeDir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await puppeteer.launch({ executablePath: browserPath, headless: false,
    args: ['--enable-unsafe-webgpu', '--window-size=1440,900'] });
  const base = `http://127.0.0.1:${server.address().port}/r/${release.id}/index.html`;
  for (const backend of ['webgpu', 'webgl']) {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      const modelUrls = new Set(), network = new Map(), errors = [], telemetryPosts = [];
      const origin = new URL(base).origin;
      cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
        if (/\/assets\/models\/[^/?]+\.glb(?:\?|$)/.test(request.url)) modelUrls.add(request.url);
        network.set(requestId, request.url);
      });
      let localBytes = 0, thirdPartyBytes = 0;
      cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
        const bytes = encodedDataLength || 0;
        if (network.get(requestId)?.startsWith(origin + '/')) localBytes += bytes;
        else thirdPartyBytes += bytes;
        network.delete(requestId);
      });
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', req => { if (req.url().includes('/api/telemetry') && req.method() === 'POST') telemetryPosts.push(req.url()); });
      page.on('response', res => { if (res.status() >= 400) errors.push(`HTTP${res.status()}: ${res.url()}`); });
      const started = performance.now();
      await page.goto(`${base}?nointro&backend=${backend}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => window.__VELANCE_QA__?.stats?.()?.loaded >= 1, { timeout: 120000 });
      const firstReadyMs = Math.round(performance.now() - started);
      await new Promise(r => setTimeout(r, 1200));
      const initial = await page.evaluate(() => ({ stats: window.__VELANCE_QA__.stats(),
        loadedIndices: [...window.__VELANCE_QA__.engine.cars.keys()] }));
      assert.equal(initial.stats.backend, backend === 'webgpu' ? 'webgpu' : 'webgl2');
      assert.equal(initial.stats.bays, 16);
      assert.equal(initial.stats.loaded, 1, 'Only focused car should load before first user navigation');
      assert.equal(initial.loadedIndices[0], 4, 'Default initial machine is McLaren P1');
      assert.equal(modelUrls.size, 1, 'Browser must not fetch all 16 GLBs during cold load');
      assert.deepEqual(await page.evaluate(() => ({
        consent: window.__VELANCE_TELEMETRY__?.consent,
        enabled: window.__VELANCE_TELEMETRY__?.enabled,
        hasSettings: !!document.getElementById('velance-telemetry-settings')
      })), { consent: 'off', enabled: false, hasSettings: true }, 'Telemetry must remain off by default');
      assert.equal(telemetryPosts.length, 0);
      const coldModelFiles = modelUrls.size, coldBytes = localBytes, coldThirdPartyBytes = thirdPartyBytes;
      await page.click('#nextCar');
      await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.cars?.has(5), { timeout: 120000 });
      assert.equal(modelUrls.size, 2, 'Navigation must add exactly one GLB');
      await page.click('#selectCar');
      await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.controls?.enabled, { timeout: 30000 });
      assert.equal(await page.evaluate(() => window.__VELANCE_QA__?.selected), 5);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.__VELANCE_QA__?.engine?.flight && window.__VELANCE_QA__?.selected === null, { timeout: 30000 });
      // Switch to an initially unloaded rear-row model and select immediately.
      // A selected model must still arrive without eager fetching at startup.
      await page.click('#rowBtn');
      await page.waitForFunction(() => !window.__VELANCE_QA__?.engine?.flight, { timeout: 30000 });
      await page.click('#selectCar');
      await page.waitForFunction(() => window.__VELANCE_QA__?.selected === 13, { timeout: 30000 });
      await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.cars?.has(13), { timeout: 120000 });
      await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.controls?.enabled, { timeout: 30000 });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.__VELANCE_QA__?.engine?.flight && window.__VELANCE_QA__?.selected === null, { timeout: 30000 });
      await page.click('#overviewBtn');
      await page.waitForFunction(() => window.__VELANCE_QA__?.stats?.()?.loaded === 16, { timeout: 180000 });
      await page.waitForFunction(() => !window.__VELANCE_QA__?.engine?.flight, { timeout: 30000 });
      assert.equal(modelUrls.size, 16, 'Explicit overview loads complete 16-model gallery');
      assert.equal((await page.evaluate(() => window.__VELANCE_QA__.stats().backend)), backend === 'webgpu' ? 'webgpu' : 'webgl2');
      // Browser UX: consent controls are operable but a release without an
      // approved private upstream cannot activate telemetry even after Allow.
      await page.click('#velance-telemetry-settings summary');
      await page.click('#velance-telemetry-allow');
      await page.waitForFunction(() => window.__VELANCE_TELEMETRY__?.consent === 'granted');
      assert.equal(await page.evaluate(() => window.__VELANCE_TELEMETRY__?.enabled), false);
      await page.click('#velance-telemetry-withdraw');
      assert.equal(await page.evaluate(() => window.__VELANCE_TELEMETRY__?.consent), 'off');
      assert.equal(telemetryPosts.length, 0, 'No telemetry POST without private upstream');
      assert.deepEqual(errors, []);
      const report = { backend: initial.stats.backend, firstReadyMs, coldModelFiles,
        coldBytes, coldThirdPartyBytes, afterOverviewModelFiles: modelUrls.size,
        finalLocalBytes: localBytes, finalThirdPartyBytes: thirdPartyBytes,
        finalLoaded: await page.evaluate(() => window.__VELANCE_QA__.stats().loaded),
        successfulSelection: true, consentDefaultOff: true, consentUiAndWithdrawalPass: true,
        telemetryPostCount: telemetryPosts.length, errors, result: 'PASS_LOCAL' };
      runs.push(report);
      process.stdout.write(`[P7 browser] ${report.backend}: cold ${coldModelFiles} GLB / ${coldBytes} transfer bytes; full gallery 16 PASS\n`);
    } finally { await context.close(); }
  }
  const result = { format: 'velance-p7-lazy-browser/1', atUtc: new Date().toISOString(),
    releaseId: release.id, chrome: await browser.version(), node: process.version,
    localOnly: true, sameMacGpu: true, distinctDevices: 0, browserContexts: 2,
    test: 'cold 1 GLB → navigate 2nd → select → rear-row on-demand select → explicit full overview 16',
    runs, overall: runs.length === 2 && runs.every(r => r.result === 'PASS_LOCAL') ? 'PASS_LOCAL' : 'FAIL_LOCAL' };
  if (out) writeFileSync(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  await browser?.close();
  await server?.shutdown();
  rmSync(tmp, { recursive: true, force: true });
}
