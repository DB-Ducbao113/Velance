// Local P3 measurement, never targets an external origin.
// node tools/perf/delivery.mjs [--browser] [--runs 1..3] [--profile loopback|constrained] [--out path]
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createOpsServer } from '../ops/server.mjs';
import { createDeliveryServer } from '../delivery/server.mjs';
import { activateRelease, createSnapshot, verifySnapshot } from '../delivery/release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), flag = (name, fallback = null) => {
  const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1];
};
const browserEnabled = args.includes('--browser');
const runs = Number(flag('--runs', '1'));
const profile = flag('--profile', 'loopback');
const output = resolve(ROOT, flag('--out', 'tools/perf/results/delivery-local.json'));
assert(Number.isInteger(runs) && runs >= 1 && runs <= 3, 'runs must be 1–3');
assert(['loopback', 'constrained'].includes(profile), 'Invalid network profile');
assert(!args.some((arg, i) => arg.startsWith('--') && !['--browser', '--runs', '--profile', '--out'].includes(arg)),
  'Unknown CLI argument');

function probe(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = request({ hostname: '127.0.0.1', port, path, method, agent: false, headers }, res => {
      let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers,
        bodyBytes: bytes, durationMs: Math.round((performance.now() - start) * 100) / 100,
        complete: res.complete }));
    });
    req.once('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('local HTTP timeout')));
    req.end();
  });
}

const count = (manifest, prefix, suffix) => manifest.files.filter(f => f.path.startsWith(prefix) && f.path.endsWith(suffix));
const q = (values, percentile) => {
  if (!values.length) return null;
  const s = values.toSorted((a, b) => a - b);
  return +(s[Math.min(s.length - 1, Math.floor(percentile * s.length))].toFixed(1));
};

async function browserPairs(baselinePort, previewPort, id) {
  // A single headed Chrome instance, fresh isolated context per cold pair.
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false, args: ['--enable-unsafe-webgpu', '--window-size=1440,900']
  });
  const cases = [];
  try {
    for (let pair = 0; pair < runs; pair++) {
      const order = pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const name of order) {
        const context = await browser.createBrowserContext();
        try {
          const page = await context.newPage();
          await page.setViewport({ width: 1440, height: 900 });
          await page.setCacheEnabled(true);
          const client = await page.createCDPSession();
          await client.send('Network.enable');
          await client.send('Network.setCacheDisabled', { cacheDisabled: false });
          await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
          if (profile === 'constrained') await client.send('Network.emulateNetworkConditions', {
            offline: false, latency: 40, downloadThroughput: 20_000_000 / 8, uploadThroughput: 5_000_000 / 8
          });
          await page.evaluateOnNewDocument(() => {
            window.__p3Frames = [];
            let last;
            const frame = time => {
              if (last != null) window.__p3Frames.push(time - last);
              last = time;
              if (window.__p3Frames.length > 12000) window.__p3Frames.splice(0, 6000);
              requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
          });
          const pageErrors = [];
          page.on('pageerror', error => pageErrors.push(String(error.message || error).slice(0, 200)));
          let records = new Map();
          client.on('Network.requestWillBeSent', e => records.set(e.requestId, { url: e.request.url, transferBytes: 0, cache: false }));
          client.on('Network.requestServedFromCache', e => { const r = records.get(e.requestId); if (r) r.cache = true; });
          client.on('Network.responseReceived', e => {
            const r = records.get(e.requestId); if (!r) return;
            r.status = e.response.status;
            r.cache ||= !!e.response.fromDiskCache || !!e.response.fromPrefetchCache;
            r.mime = e.response.mimeType;
          });
          client.on('Network.loadingFinished', e => {
            const r = records.get(e.requestId); if (r) r.transferBytes = e.encodedDataLength || 0;
          });
          const base = name === 'baseline' ? `http://127.0.0.1:${baselinePort}`
            : `http://127.0.0.1:${previewPort}`;
          const url = name === 'baseline' ? `${base}/index.html?notelemetry`
            : `${base}/r/${id}/index.html?notelemetry`;
          for (const stage of ['cold', 'warm']) {
            records = new Map();
            const start = performance.now();
            const response = stage === 'cold'
              ? await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
              : await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            const gateMs = +(performance.now() - start).toFixed(1);
            let firstCarMs = null, allLoadedMs = null, fallback = false;
            try {
              await page.waitForFunction(() => {
                const s = window.__VELANCE_QA__?.stats?.();
                return s && (s.loaded >= 1 || window.__VELANCE_QA__?.fallback);
              }, { timeout: 60000 });
              firstCarMs = +(performance.now() - start).toFixed(1);
              await page.waitForFunction(() => {
                const q = window.__VELANCE_QA__, s = q?.stats?.();
                return q?.fallback || s?.loaded === 16;
              }, { timeout: 120000 });
              allLoadedMs = +(performance.now() - start).toFixed(1);
              fallback = !!(await page.evaluate(() => window.__VELANCE_QA__?.fallback));
            } catch (error) {
              pageErrors.push(`load timeout: ${error.message.slice(0, 120)}`);
            }
            const frame = await page.evaluate(() => window.__p3Frames || []);
            const own = [...records.values()].filter(r => r.url?.startsWith(base + '/'));
            const thirdParty = [...records.values()].filter(r => r.url?.startsWith('http') && !r.url.startsWith(base + '/'));
            cases.push({ pair, order, name, stage, status: response.status(), gateMs, firstCarMs, allLoadedMs, fallback,
              browserCacheHits: own.filter(r => r.cache).length,
              browserNetworkBytes: own.reduce((s, r) => s + (r.cache ? 0 : r.transferBytes), 0),
              thirdPartyNetworkBytes: thirdParty.reduce((s, r) => s + (r.cache ? 0 : r.transferBytes), 0),
              httpStatuses: Object.fromEntries([...new Set(own.map(r => r.status).filter(Boolean))].map(status => [status, own.filter(r => r.status === status).length])),
              requests: own.length, frameGapMs: { avg: frame.length ? +(frame.reduce((a, b) => a + b, 0) / frame.length).toFixed(1) : null,
                p95: q(frame, .95), max: q(frame, 1) },
              errors: [...pageErrors] });
            console.log(`[delivery] browser ${name} ${stage}: ${own.length} resources, ${cases.at(-1).browserNetworkBytes} network bytes, allLoaded ${allLoadedMs ?? 'unavailable'} ms`);
          }
        } finally { await context.close(); }
      }
    }
  } finally { await browser.close(); }
  return cases;
}

const temp = mkdtempSync(join(os.tmpdir(), 'velance-p3-measure-')), storeDir = join(temp, 'releases-private');
const dbPath = join(temp, 'fixture.db');
let ops, preview;
try {
  const snapshotStarted = performance.now();
  const snapshot = await createSnapshot({ sourceRoot: ROOT, storeDir });
  const snapshotMs = +(performance.now() - snapshotStarted).toFixed(1);
  await verifySnapshot({ storeDir, id: snapshot.id });
  await activateRelease({ storeDir, id: snapshot.id });
  ops = await createOpsServer({ root: ROOT, dbPath });
  ops.listen(0, '127.0.0.1'); await once(ops, 'listening');
  preview = createDeliveryServer({ storeDir });
  preview.listen(0, '127.0.0.1'); await once(preview, 'listening');
  const baselinePort = ops.address().port, previewPort = preview.address().port;
  const files = snapshot.manifest.files, publicBytes = files.reduce((s, f) => s + f.bytes, 0);
  const probes = {};
  for (const [label, path] of Object.entries({
    html: '/index.html', js: '/src/ui/app.js', css: '/styles/main.css',
    glb: '/assets/models/mclaren_p1.glb'
  })) {
    probes[label] = {};
    for (const representation of ['identity', 'gzip', 'br']) {
      const headers = { 'Accept-Encoding': representation };
      const raw = await probe(baselinePort, path, { headers });
      const current = await probe(previewPort, `/r/${snapshot.id}${path}`, { headers });
      assert.equal(raw.status, 200); assert.equal(current.status, 200);
      probes[label][representation] = { mutable: { bytes: raw.bodyBytes, ms: raw.durationMs, etag: raw.headers.etag },
        immutable: { bytes: current.bodyBytes, ms: current.durationMs, etag: current.headers.etag } };
      if (representation === 'br' && label === 'glb') assert.equal(current.headers['content-encoding'], undefined);
    }
    const revalidated = await probe(baselinePort, path, { headers: { 'If-None-Match': probes[label].identity.mutable.etag } });
    assert.equal(revalidated.status, 304);
    const warmRelease = await probe(previewPort, `/r/${snapshot.id}${path}`, {
      headers: { 'If-None-Match': probes[label].identity.immutable.etag } });
    assert.equal(warmRelease.status, 304);
    probes[label].revalidate = { mutable: revalidated.status, immutable: warmRelease.status };
  }
  const results = {
    format: 'velance-p3-local-measurement/1', measuredAtUtc: new Date().toISOString(),
    environment: { os: os.platform(), osVersion: os.release(), arch: os.arch(),
      node: process.version, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length },
    settings: { browserEnabled, runs, profile, onlyLoopback: true, fakeDb: true },
    release: { id: snapshot.id, files: files.length, publicBytes, publicMB: +(publicBytes / 1e6).toFixed(3),
      models: count(snapshot.manifest, '/assets/models/', '.glb').length,
      editorialWebp: count(snapshot.manifest, '/assets/images/', '.webp').length,
      environmentWebp: count(snapshot.manifest, '/assets/environment/', '.webp').length, snapshotMs },
    http: probes,
    browser: browserEnabled ? await browserPairs(baselinePort, previewPort, snapshot.id) : null,
    caveats: ['Loopback HTTP measurements are not CDN POP hit ratios, prices, WAN or production capacity.',
      'Browser/CDP baseline is not proof of public origin security or global availability.']
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`[delivery] wrote ${output}`);
  console.log(JSON.stringify({ release: results.release, http: Object.fromEntries(Object.entries(probes)
    .map(([name, p]) => [name, { identity: p.identity.immutable.bytes, br: p.br.immutable.bytes }])) }));
} finally {
  if (preview?.listening) await preview.shutdown();
  if (ops) await ops.shutdown();
  rmSync(temp, { recursive: true, force: true });
}
