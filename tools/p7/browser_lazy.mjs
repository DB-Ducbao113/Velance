// P7 real Chrome / immutable snapshot. One browser reused for two backends.
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
  browser = await puppeteer.launch({ executablePath: browserPath, headless: process.env.QA_HEADLESS === '1',
    args: ['--enable-unsafe-webgpu', '--window-size=1440,900'] });
  const base = `http://127.0.0.1:${server.address().port}/r/${release.id}/index.html`;
  for (const backend of ['webgpu', 'webgl']) {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // Test lazy loading and accessibility of the reduced-motion journey;
      // animation timing is measured by dedicated cinematic/motion harnesses.
      await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
      const clickControl = async selector => {
        await page.waitForFunction(sel => {
          const node = document.querySelector(sel);
          if (!node || node.disabled || node.closest('[inert]')) return false;
          const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
          if (!rect.width || !rect.height || style.visibility !== 'visible' || style.pointerEvents === 'none') return false;
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return node.contains(hit);
        }, {timeout:15000}, selector);
        await page.click(selector);
      };
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      const galleryUrls = new Set(), detailUrls = new Set(), unexpectedModelUrls = new Set();
      const network = new Map(), errors = [], telemetryPosts = [], collectorRequests = [], capabilityRequests = [], externalRequests = [];
      const origin = new URL(base).origin;
      // An existing grant must not activate telemetry on an ordinary visit.
      await page.evaluateOnNewDocument(() => {
        if (new URLSearchParams(location.search).get('diagnostics') !== '1') {
          localStorage.setItem('velance_telemetry_consent_v1',
            JSON.stringify({ version: 1, decision: 'granted', at: Date.now() }));
        }
      });
      cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith('.glb')) {
          if (/\/assets\/models\/gallery\/[^/]+\.glb$/.test(path)) galleryUrls.add(path);
          else if (/\/assets\/models\/detail\/[^/]+\.glb$/.test(path)) detailUrls.add(path);
          else unexpectedModelUrls.add(path);
        }
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
      page.on('console', msg => {
        if (msg.type() === 'error' || (msg.type() === 'warn' &&
            /GLTFLoader|texture|pipeline warm-up failed|3D engine unavailable|VÉLANCE \/ (?:BAY|DETAIL)|Content Security Policy/i.test(msg.text()))) {
          errors.push(`console ${msg.type()}: ${msg.text()}`);
        }
      });
      page.on('request', req => {
        const url = new URL(req.url()), path = url.pathname;
        if (/^https?:$/.test(url.protocol) && url.origin !== origin) externalRequests.push(req.url());
        if (path.endsWith('/telemetry/collector.js')) collectorRequests.push(req.url());
        if (path === new URL(base).pathname && req.method() === 'HEAD') capabilityRequests.push(req.url());
        if (path === '/api/telemetry' && req.method() === 'POST') telemetryPosts.push(req.url());
      });
      page.on('requestfailed', req => {
        const reason = req.failure()?.errorText;
        if (reason !== 'net::ERR_ABORTED' || /\.glb(?:\?|$)/.test(req.url())) errors.push(`request failed: ${reason}: ${req.url()}`);
      });
      page.on('response', res => { if (res.status() >= 400) errors.push(`HTTP${res.status()}: ${res.url()}`); });
      const decodedImages = () => page.evaluate(() => {
        const counts = {};
        for (const [i, root] of window.__VELANCE_QA__.engine.cars) {
          const images = new Set();
          root.traverse(n => {
            for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
              if (!m) continue;
              for (const t of [...Object.values(m), m.userData?.baseMap]) {
                if (t?.isTexture && t.image?.width > 0 && t.image?.height > 0) images.add(t.image);
              }
            }
          });
          counts[i] = images.size;
        }
        return counts;
      });
      const assertVisitor = async () => {
        assert.deepEqual(await page.evaluate(() => ({
          collector: '__VELANCE_TELEMETRY__' in window,
          hasSettings: !!document.getElementById('velance-telemetry-settings'),
          savedGrant: JSON.parse(localStorage.getItem('velance_telemetry_consent_v1') || 'null')?.decision
        })), { collector: false, hasSettings: false, savedGrant: 'granted' });
        assert.equal(collectorRequests.length, 0);
        assert.equal(capabilityRequests.length, 0);
        assert.equal(telemetryPosts.length, 0);
      };
      const started = performance.now();
      const response = await page.goto(`${base}?nointro&backend=${backend}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      assert(response?.headers()['content-security-policy'], 'Must run under the real delivery CSP');
      await page.waitForFunction(() => window.__VELANCE_QA__?.stats?.()?.loaded >= 1, { timeout: 120000 });
      const firstReadyMs = Math.round(performance.now() - started);
      await new Promise(r => setTimeout(r, 1200));
      const initial = await page.evaluate(() => ({ stats: window.__VELANCE_QA__.stats(),
        loadedIndices: [...window.__VELANCE_QA__.engine.cars.keys()] }));
      assert.equal(initial.stats.backend, backend === 'webgpu' ? 'webgpu' : 'webgl2');
      assert.equal(initial.stats.bays, 16);
      assert.equal(initial.stats.loaded, 1, 'Only focused car should load before first user navigation');
      assert.equal(initial.loadedIndices[0], 4, 'Default initial machine is McLaren P1');
      assert.equal(galleryUrls.size, 1, 'Only one gallery GLB on cold load');
      assert.match([...galleryUrls][0], /\/gallery\/mclaren_p1\.glb$/);
      assert.equal(detailUrls.size, 0, 'No cold detail GLB');
      assert((await decodedImages())[4] > 0, 'Cold P1 must retain decoded textures');
      await assertVisitor();
      const coldGalleryFiles = galleryUrls.size, coldDetailFiles = detailUrls.size;
      const coldBytes = localBytes, coldThirdPartyBytes = thirdPartyBytes;
      await clickControl('#nextCar');
      await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.cars?.has(5), { timeout: 120000 });
      await page.waitForFunction(() => window.__VELANCE_QA__?.focus === 5 && !window.__VELANCE_QA__?.engine?.flight, {timeout: 15000});
      assert.equal(galleryUrls.size, 2, 'Navigation must add exactly one gallery GLB');
      assert.equal(detailUrls.size, 0, 'Navigation alone must not fetch detail');
      await clickControl('#selectCar');
      await page.waitForFunction(() => window.__VELANCE_QA__?.selected === 5, { timeout: 10000 })
        .catch(async error => { console.error('Selection click did not reach the intended control', await page.evaluate(() => ({focus: window.__VELANCE_QA__?.focus, selected: window.__VELANCE_QA__?.selected, engine: window.__VELANCE_QA__?.engine?.mode, selectButton: document.querySelector('#selectCar')?.getBoundingClientRect().toJSON()}))); throw error; });
      await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.controls?.enabled &&
        window.__VELANCE_QA__?.engine?.detailResident?.index === 5, { timeout: 60000 })
        .catch(async error => { console.error('Detail wait', errors, await page.evaluate(() => ({selected:window.__VELANCE_QA__?.selected, mode:window.__VELANCE_QA__?.engine?.mode, backend:window.__VELANCE_QA__?.engine?.backend, resident:window.__VELANCE_QA__?.engine?.detailResident?.index, pending:window.__VELANCE_QA__?.engine?.pendingDetail?.index, controls:window.__VELANCE_QA__?.engine?.controls?.enabled, studio:window.__VELANCE_QA__?.engine?.studioActive, flight:window.__VELANCE_QA__?.engine?.flight?.t}))); throw error; });
      assert.equal(await page.evaluate(() => window.__VELANCE_QA__?.selected), 5);
      assert.equal(detailUrls.size, 1);
      assert.match([...detailUrls][0], /\/detail\/mercedes-amg_project-one\.glb$/);
      const texturedDetailImages = (await decodedImages())[5];
      assert(texturedDetailImages > 0, 'Selected AMG detail must retain decoded textures');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.__VELANCE_QA__?.engine?.flight &&
        !window.__VELANCE_QA__?.engine?.returning && !window.__VELANCE_QA__?.engine?.detailResident &&
        window.__VELANCE_QA__?.selected === null, { timeout: 30000 });
      // Switch to an initially unloaded rear-row model and select immediately.
      // A selected model must still arrive without eager fetching at startup.
      await clickControl('#rowBtn');
      await page.waitForFunction(() => window.__VELANCE_QA__?.row === 1 && window.__VELANCE_QA__?.focus === 13 && !window.__VELANCE_QA__?.engine?.flight, { timeout: 10000 });
      await clickControl('#selectCar');
      await page.waitForFunction(() => window.__VELANCE_QA__?.selected === 13, { timeout: 30000 });
      await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.cars?.has(13), { timeout: 120000 });
      await page.waitForFunction(() => window.__VELANCE_QA__?.engine?.controls?.enabled &&
        window.__VELANCE_QA__?.engine?.detailResident?.index === 13, { timeout: 120000 });
      assert.equal(galleryUrls.size, 3);
      assert.equal(detailUrls.size, 2);
      assert([...detailUrls].some(url => url.endsWith('/detail/mclaren-765lt___with_windows__v2.glb')));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.__VELANCE_QA__?.engine?.flight &&
        !window.__VELANCE_QA__?.engine?.returning && !window.__VELANCE_QA__?.engine?.detailResident &&
        window.__VELANCE_QA__?.selected === null, { timeout: 30000 });
      await clickControl('#overviewBtn');
      await page.waitForFunction(() => window.__VELANCE_QA__?.stats?.()?.loaded === 16, { timeout: 180000 });
      await page.waitForFunction(() => !window.__VELANCE_QA__?.engine?.flight, { timeout: 30000 });
      assert.equal(galleryUrls.size, 16, 'Explicit overview loads complete 16-model gallery');
      assert.equal(detailUrls.size, 2, 'Overview must not request more detail GLBs');
      assert.equal(unexpectedModelUrls.size, 0);
      const galleryImageCounts = await decodedImages();
      // Current gallery GLB inventory has 13 textured vehicles; the remaining
      // three (10, 12, 13) use only material colors.
      const texturedGalleryModels = Object.values(galleryImageCounts).filter(n => n > 0).length;
      assert.equal(Object.keys(galleryImageCounts).length, 16);
      assert.equal(texturedGalleryModels, 13, JSON.stringify(galleryImageCounts));
      assert.equal((await page.evaluate(() => window.__VELANCE_QA__.stats().backend)), backend === 'webgpu' ? 'webgpu' : 'webgl2');
      await assertVisitor();
      const finalLocalBytes = localBytes, finalThirdPartyBytes = thirdPartyBytes;
      const finalLoaded = await page.evaluate(() => window.__VELANCE_QA__.stats().loaded);
      const afterOverviewGalleryFiles = galleryUrls.size, afterOverviewDetailFiles = detailUrls.size;
      // Start a fresh explicit diagnostic visit; old permission was deliberately
      // present only on the visitor journey.
      await page.evaluate(() => localStorage.removeItem('velance_telemetry_consent_v1'));
      await page.goto(`${base}?nointro&backend=${backend}&diagnostics=1`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.__VELANCE_TELEMETRY__?.consent === 'off');
      assert.equal(collectorRequests.length, 1);
      assert.equal(capabilityRequests.length, 0);
      assert.equal(await page.evaluate(() => window.__VELANCE_TELEMETRY__.enabled), false);
      // Browser UX: consent controls are operable but a release without an
      // approved private upstream cannot activate telemetry even after Allow.
      await page.click('#velance-telemetry-settings summary');
      const capability = page.waitForResponse(res => res.request().method() === 'HEAD' &&
        new URL(res.url()).pathname === new URL(base).pathname);
      await page.click('#velance-telemetry-allow');
      await page.waitForFunction(() => window.__VELANCE_TELEMETRY__?.consent === 'granted');
      const probe = await capability;
      assert.equal(probe.status(), 200);
      assert.notEqual(probe.headers()['x-velance-ops'], '1');
      assert.equal(capabilityRequests.length, 1);
      assert.equal(await page.evaluate(() => window.__VELANCE_TELEMETRY__?.enabled), false);
      await page.click('#velance-telemetry-withdraw');
      assert.equal(await page.evaluate(() => window.__VELANCE_TELEMETRY__?.consent), 'off');
      assert.equal(await page.evaluate(() => window.__VELANCE_TELEMETRY__?.session), null);
      assert.equal(await page.evaluate(() => localStorage.getItem('velance_telemetry_off')), '1');
      assert.equal(telemetryPosts.length, 0, 'No telemetry POST without private upstream');
      assert.deepEqual(externalRequests, [], 'Local visitor and diagnostics must not request external HTTP resources');
      assert.deepEqual(errors, []);
      const report = { backend: initial.stats.backend, firstReadyMs, coldGalleryFiles, coldDetailFiles,
        coldBytes, coldThirdPartyBytes, afterOverviewGalleryFiles, afterOverviewDetailFiles,
        finalLocalBytes, finalThirdPartyBytes, finalLoaded, texturedGalleryModels, texturedDetailImages,
        galleryImageCounts, unexpectedModelFiles: unexpectedModelUrls.size,
        successfulSelection: true, visitorIsolationWithSavedGrant: true, diagnosticsDefaultOff: true,
        consentUiAndWithdrawalPass: true, collectorRequestCount: collectorRequests.length,
        capabilityRequestCount: capabilityRequests.length,
        telemetryPostCount: telemetryPosts.length, externalHttpRequestCount: externalRequests.length, errors, result: 'PASS_LOCAL' };
      runs.push(report);
      process.stdout.write(`[P7 browser] ${report.backend}: cold ${coldGalleryFiles} gallery GLB / ${coldBytes} transfer bytes; full gallery 16, detail 2 PASS\n`);
    } finally { await context.close(); }
  }
  const result = { format: 'velance-p7-lazy-browser/2', atUtc: new Date().toISOString(),
    releaseId: release.id, chrome: await browser.version(), node: process.version,
    localOnly: true, browserMode: process.env.QA_HEADLESS === '1' ? 'headless' : 'headed', reducedMotion: true,
    sameMacGpu: true, distinctDevices: 0, browserContexts: 2,
    test: 'cold 1 gallery → navigate 2nd → select detail → rear-row on-demand detail → full overview 16 gallery / 2 detail → explicit diagnostics',
    runs, overall: runs.length === 2 && runs.every(r => r.result === 'PASS_LOCAL') ? 'PASS_LOCAL' : 'FAIL_LOCAL' };
  if (out) writeFileSync(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  await browser?.close();
  await server?.shutdown();
  rmSync(tmp, { recursive: true, force: true });
}
