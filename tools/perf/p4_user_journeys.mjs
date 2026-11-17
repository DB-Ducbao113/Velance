// P4: local-only HTTP user journeys against a private snapshot of REAL showroom assets.
// 100 virtual HTTP clients are NOT 100 browser sessions, a CDN simulation or a user-capacity claim.
// Usage: node tools/perf/p4_user_journeys.mjs --users 10,25,50,100 --concurrency 16 --images 5 --out /tmp/p4-journeys.json
// For a small validation: --users 1 --concurrency 2 --images 0.
import { createHash } from 'node:crypto';
import { Agent, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, lstatSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, arch, cpus, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createSnapshot, activateRelease, readActiveRelease, verifySnapshot } from '../delivery/release.mjs';
import { createDeliveryServer } from '../delivery/server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HOST = '127.0.0.1';
const USER_SIZES = new Set([1, 10, 25, 50, 100]);
const MAX_GLOBAL_DOWNLOADS = 32;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_ELIGIBLE_ASSET_BYTES = 256 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PROFILE_SECONDS = 240;
const MIME = { '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8' };
const n3 = n => Number.isFinite(n) ? +n.toFixed(3) : null;
const assertSafe = (ok, message) => { if (!ok) throw new Error(message); };

export function parseJourneyArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const values = {}, allowed = new Set(['--users', '--images', '--concurrency', '--max-seconds', '--source-root', '--out']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    assertSafe(allowed.has(key) && value && !value.startsWith('--') && !Object.hasOwn(values, key), `Invalid or duplicate argument: ${key}`);
    values[key] = value;
  }
  assertSafe(Object.hasOwn(values, '--users') && Object.hasOwn(values, '--out'),
    'Explicit --users 1|10|25|50|100 (comma-separated) and --out <new file> are required');
  const users = values['--users'].split(',').map(value => {
    assertSafe(/^(?:1|10|25|50|100)$/.test(value), `Unsupported users count: ${value}`);
    return Number(value);
  });
  assertSafe(users.length <= 4 && users.length === new Set(users).size, 'User profile sizes must be unique (max four)');
  const integer = (arg, fallback) => {
    const text = values[arg];
    if (text === undefined) return fallback;
    assertSafe(/^(?:0|[1-9]\d*)$/.test(text), `${arg} must be an integer`);
    return Number(text);
  };
  const options = {
    users, images: integer('--images', 0), concurrency: integer('--concurrency', 16),
    maxSeconds: integer('--max-seconds', 120), sourceRoot: resolve(values['--source-root'] ?? ROOT),
    out: resolve(values['--out'])
  };
  validateOptions(options);
  return options;
}

function validateOptions({ users, images, concurrency, maxSeconds, sourceRoot, out }) {
  assertSafe(Array.isArray(users) && users.length >= 1 && users.length <= 4 && users.every(n => USER_SIZES.has(n))
    && new Set(users).size === users.length, 'users must be unique entries from 1,10,25,50,100');
  assertSafe(images === 0 || images === 5, 'images must be 0 or 5 per virtual client');
  assertSafe(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= MAX_GLOBAL_DOWNLOADS,
    `concurrency must be 1..${MAX_GLOBAL_DOWNLOADS}`);
  assertSafe(Number.isSafeInteger(maxSeconds) && maxSeconds >= 5 && maxSeconds <= MAX_PROFILE_SECONDS,
    `maxSeconds must be 5..${MAX_PROFILE_SECONDS}`);
  assertSafe(typeof sourceRoot === 'string' && sourceRoot.length > 0, 'sourceRoot is required');
  assertSafe(out === null || (typeof out === 'string' && out.length > 0), 'out must be null or a path');
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return n3(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]);
}
function summary(values) {
  return { count: values.length, p50: percentile(values, .5), p95: percentile(values, .95),
    p99: percentile(values, .99), max: values.length ? n3(Math.max(...values)) : null };
}
function count(files, prefix, suffix) { return files.filter(file => file.path.startsWith(prefix) && file.path.endsWith(suffix)); }

// Check real inventory before any release creation. Do not silently substitute missing media.
export function validateAssetInventory({ sourceRoot, expectedModels = 16, expectedImages = 80 } = {}) {
  assertSafe(typeof sourceRoot === 'string', 'sourceRoot must be a directory');
  const modelsRoot = join(sourceRoot, 'assets/models'), imagesRoot = join(sourceRoot, 'assets/images');
  for (const path of [modelsRoot, imagesRoot]) {
    const s = lstatSync(path);
    assertSafe(s.isDirectory() && !s.isSymbolicLink(), `Expected real directory: ${path}`);
  }
  const modelEntries = readdirSync(modelsRoot, { withFileTypes: true });
  const models = modelEntries.filter(entry => entry.name.endsWith('.glb'));
  // The real source also contains a manifest and README/drop-zone metadata.
  // Snapshot allowlist excludes them; the only eligible model assets are *.glb.
  assertSafe(models.length === expectedModels && models.every(entry => entry.isFile() && !entry.isSymbolicLink()),
    `Model inventory mismatch: expected ${expectedModels} regular GLBs, found ${models.length} GLBs (${modelEntries.length} entries total)`);
  const imageFolders = readdirSync(imagesRoot, { withFileTypes: true }).filter(entry => entry.name !== 'README.md');
  const images = [];
  assertSafe(imageFolders.length === expectedImages / 5 && imageFolders.every(entry => entry.isDirectory() && !entry.isSymbolicLink()),
    `Image inventory mismatch: expected ${expectedImages / 5} car image folders`);
  const albums = [];
  for (const folder of imageFolders.sort((a, b) => a.name.localeCompare(b.name))) {
    const files = readdirSync(join(imagesRoot, folder.name), { withFileTypes: true });
    const webps = files.filter(entry => entry.name.endsWith('.webp'));
    // Original PNG masters are intentionally excluded from the immutable release.
    assertSafe(webps.length === 5 && webps.every(entry => entry.isFile() && !entry.isSymbolicLink()),
      `Expected exactly 5 regular WebP files in ${folder.name}`);
    const album = webps.map(entry => `/assets/images/${folder.name}/${entry.name}`).sort();
    albums.push(album);
    images.push(...album);
  }
  assertSafe(images.length === expectedImages, `Image count mismatch: expected ${expectedImages}, got ${images.length}`);
  const modelPaths = models.map(entry => `/assets/models/${entry.name}`).sort();
  const expectedBytes = [...modelPaths, ...images].reduce((bytes, path) => {
    const size = statSync(join(sourceRoot, path.slice(1))).size;
    assertSafe(Number.isSafeInteger(size) && size > 0 && size <= MAX_RESPONSE_BYTES,
      `Unsupported media size at ${path} (${size} bytes)`);
    return bytes + size;
  }, 0);
  assertSafe(expectedBytes <= MAX_TOTAL_ELIGIBLE_ASSET_BYTES,
    `Eligible source assets exceed bounded snapshot budget (${expectedBytes} > ${MAX_TOTAL_ELIGIBLE_ASSET_BYTES})`);
  return { modelPaths, imagePaths: images, albums, modelCount: models.length,
    imageCount: images.length, expectedBytes, allModelBytes: modelPaths.reduce((s, path) => s + statSync(join(sourceRoot, path.slice(1))).size, 0) };
}

function fileDiskStats(path) {
  let files = 0, bytes = 0;
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) { files++; bytes += statSync(p).size; }
    }
  }
  walk(path);
  let fsAvailableBytes = null;
  try { const d = statfsSync(path); fsAvailableBytes = d.bavail * d.bsize; } catch {}
  return { snapshotDiskFiles: files, snapshotApparentBytes: bytes, fsAvailableBytes };
}

// Response bytes are consumed and hashed chunk by chunk. Never Buffer.concat a GLB.
function requestStream({ port, path, headers = {}, agent, signal, method = 'GET', timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise(resolveResult => {
    let settled = false, responseStatus = null, responseHeaders = {}, bytes = 0, firstByteMs = null, headerMs = null;
    const hash = createHash('sha256'), started = performance.now();
    let req, timer;
    const finish = (error = null, complete = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ status: responseStatus, complete, error,
        bytes, sha256: hash.digest('hex'), latencyMs: n3(performance.now() - started),
        headersMs: headerMs, firstByteMs, headers: responseHeaders });
    };
    req = httpRequest({ hostname: HOST, port, path, method, headers: { 'Accept-Encoding': 'identity', ...headers },
      agent, signal }, res => {
      responseStatus = res.statusCode;
      headerMs = n3(performance.now() - started);
      for (const name of ['etag', 'cache-control', 'vary', 'content-length', 'content-type', 'content-encoding', 'location']) {
        responseHeaders[name] = res.headers[name] ?? null;
      }
      res.on('data', chunk => {
        if (settled) return;
        if (firstByteMs === null) firstByteMs = n3(performance.now() - started);
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) { req.destroy(Object.assign(new Error('oversized transfer'), { code: 'RESPONSE_TOO_LARGE' })); return; }
        hash.update(chunk);
      });
      res.once('end', () => finish(res.complete ? null : 'INCOMPLETE_RESPONSE', res.complete));
      res.once('aborted', () => finish('RESPONSE_ABORTED', false));
      res.once('error', err => finish(err.code || 'RESPONSE_ERROR', false));
      res.once('close', () => { if (!res.complete) finish('RESPONSE_CLOSED', false); });
    });
    req.once('error', err => finish(err.code || 'REQUEST_ERROR', false));
    timer = setTimeout(() => req.destroy(Object.assign(new Error('request timeout'), { code: 'REQUEST_TIMEOUT' })), timeoutMs);
    timer.unref();
    req.end();
  });
}

// Keep the complete client's pending tasks <=100, with at most 32 global active downloads.
class DownloadSlots {
  constructor(cap) { this.cap = cap; this.active = 0; this.peak = 0; this.queue = []; }
  async acquire(signal) {
    if (signal.aborted) throw Object.assign(new Error('profile deadline'), { code: 'PROFILE_TIMEOUT' });
    if (this.active < this.cap) {
      this.active++; this.peak = Math.max(this.active, this.peak);
      return () => this.release();
    }
    return await new Promise((ok, no) => {
      const waiter = { ok: null };
      const aborted = () => {
        this.queue = this.queue.filter(item => item !== waiter);
        no(Object.assign(new Error('profile deadline'), { code: 'PROFILE_TIMEOUT' }));
      };
      waiter.ok = () => { signal.removeEventListener('abort', aborted); ok(() => this.release()); };
      signal.addEventListener('abort', aborted, { once: true });
      this.queue.push(waiter);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) next.ok();
    else this.active--;
  }
}

export function validateHttpObject(result, spec, warm = false) {
  const failures = [];
  if (result.error || !result.complete) failures.push(result.error || 'INCOMPLETE_RESPONSE');
  if (warm) {
    if (result.status !== 304) failures.push(`EXPECTED_304_GOT_${result.status}`);
    if (result.bytes !== 0) failures.push('304_HAS_BODY');
    if (result.headers['content-length'] !== null) failures.push('304_HAS_CONTENT_LENGTH');
  } else {
    if (result.status !== 200) failures.push(`EXPECTED_200_GOT_${result.status}`);
    if (result.bytes !== spec.bytes) failures.push('SIZE_MISMATCH');
    if (result.sha256 !== spec.sha256) failures.push('SHA256_MISMATCH');
    if (result.headers['content-length'] !== String(spec.bytes)) failures.push('CONTENT_LENGTH_MISMATCH');
  }
  if (result.headers.etag !== `"${spec.sha256}-identity"`) failures.push('ETAG_MISMATCH');
  if (result.headers['cache-control'] !== 'public, max-age=31536000, immutable') failures.push('IMMUTABLE_CACHE_MISMATCH');
  if (result.headers.vary !== 'Accept-Encoding') failures.push('VARY_MISMATCH');
  if (result.headers['content-encoding'] !== null) failures.push('BINARY_COMPRESSED');
  const mime = spec.path.endsWith('.glb') ? MIME['.glb'] : MIME['.webp'];
  if (result.headers['content-type'] !== mime) failures.push('MIME_MISMATCH');
  return failures;
}

// HTTP pointer / -> 307 versioned URL; versioned HTML must match snapshot bytes/hash.
async function checkActiveRoute({ port, release, agent, signal }) {
  const pointer = await requestStream({ port, path: '/', agent, signal });
  const desiredLocation = `/r/${release.id}/index.html`;
  const pointerValid = pointer.status === 307 && pointer.complete && pointer.headers.location === desiredLocation
    && pointer.headers['cache-control'] === 'no-store';
  const html = release.manifest.files.find(file => file.path === '/index.html');
  assertSafe(html, 'Expected index.html in immutable release');
  const page = await requestStream({ port, path: desiredLocation, agent, signal });
  const pageValid = page.status === 200 && page.complete && page.bytes === html.bytes && page.sha256 === html.sha256
    && page.headers.etag === `"${html.sha256}-identity"`
    && page.headers['content-length'] === String(html.bytes)
    && page.headers['cache-control'] === 'public, max-age=31536000, immutable';
  return { passed: pointerValid && pageValid, pointerStatus: pointer.status, location: pointer.headers.location,
    pointerCacheControl: pointer.headers['cache-control'], htmlStatus: page.status, htmlBytes: page.bytes,
    htmlDigestValid: page.sha256 === html.sha256, htmlEtag: page.headers.etag,
    errors: [pointer.error, page.error].filter(Boolean) };
}

async function runProfile({ userCount, images, concurrency, maxSeconds, port, release, modelPaths, albums, storeDir, agent }) {
  const specs = new Map(release.manifest.files.map(file => [file.path, file]));
  const slots = new DownloadSlots(concurrency), controller = new AbortController();
  const started = performance.now(), cpuStart = process.cpuUsage(), memStart = process.memoryUsage();
  const diskBefore = fileDiskStats(storeDir), resourceStart = process.resourceUsage();
  let rssPeak = memStart.rss;
  const rssTimer = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 100);
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const deadline = setTimeout(() => controller.abort(), maxSeconds * 1000);
  const requestStats = { offered: 0, sent: 0, completed: 0, completed200: 0, completed304: 0,
    incomplete200: 0, timeouts: 0, status429: 0, status503: 0, otherStatuses: {},
    verifiedFiles: 0, failedVerification: 0, receivedBodyBytes: 0, verifiedBodyBytes: 0, warmBodyBytes: 0,
    failuresByCode: {} };
  const pathTimes = new Map(), journeys = [];
  const tallyError = key => { requestStats.failuresByCode[key] = (requestStats.failuresByCode[key] ?? 0) + 1; };
  async function fetch(path, warm = false) {
    requestStats.offered++;
    const spec = specs.get(path);
    if (!spec) throw new Error(`RELEASE_ASSET_MISSING: ${path}`);
    let releaseSlot;
    try { releaseSlot = await slots.acquire(controller.signal); }
    catch (error) {
      requestStats.timeouts++;
      tallyError(error.code || 'QUEUE_FAILED');
      return { path, warm, status: null, complete: false, bytes: 0, sha256: null, latencyMs: null,
        headersMs: null, firstByteMs: null, verified: false, errors: [error.code || 'QUEUE_FAILED'] };
    }
    try {
      requestStats.sent++;
      const response = await requestStream({ port, path: `/r/${release.id}${path}`, agent, signal: controller.signal,
        headers: warm ? { 'If-None-Match': `"${spec.sha256}-identity"` } : {} });
      requestStats.receivedBodyBytes += response.bytes;
      if (warm) requestStats.warmBodyBytes += response.bytes;
      if (response.complete) requestStats.completed++;
      if (response.status === 200 && response.complete) requestStats.completed200++;
      if (response.status === 304 && response.complete) requestStats.completed304++;
      if (response.status === 200 && !response.complete) requestStats.incomplete200++;
      if (response.status === 429) requestStats.status429++;
      if (response.status === 503) requestStats.status503++;
      if (response.status !== 200 && response.status !== 304 && response.status !== 429 && response.status !== 503) {
        const status = response.status === null ? 'transport' : String(response.status);
        requestStats.otherStatuses[status] = (requestStats.otherStatuses[status] ?? 0) + 1;
      }
      if (response.error?.includes('TIMEOUT') || response.error === 'ABORT_ERR') requestStats.timeouts++;
      const errors = validateHttpObject(response, spec, warm), verified = errors.length === 0;
      if (verified && !warm) { requestStats.verifiedFiles++; requestStats.verifiedBodyBytes += response.bytes; }
      if (!verified) {
        requestStats.failedVerification++;
        for (const error of errors) tallyError(error);
      }
      if (!warm) {
        const list = pathTimes.get(path) ?? [];
        list.push(response.latencyMs);
        pathTimes.set(path, list);
      }
      return { path, warm, status: response.status, complete: response.complete, bytes: response.bytes,
        sha256: response.sha256, latencyMs: response.latencyMs, headersMs: response.headersMs,
        firstByteMs: response.firstByteMs, etag: response.headers.etag,
        contentLength: response.headers['content-length'], verified, errors };
    } finally { releaseSlot(); }
  }
  async function journey(userIndex) {
    const began = performance.now(), models = [], pictures = [];
    let firstAssetReadyMs = null, all16ReadyMs = null;
    // The virtual user fetches all models sequentially; global users overlap.
    // A real browser's loading/scheduling and renderer are not simulated.
    for (const path of modelPaths) {
      if (controller.signal.aborted) break;
      const result = await fetch(path);
      models.push(result);
      if (result.verified && firstAssetReadyMs === null) firstAssetReadyMs = n3(performance.now() - began);
    }
    if (models.length === 16 && models.every(item => item.verified)) all16ReadyMs = n3(performance.now() - began);
    if (images === 5 && !controller.signal.aborted) {
      for (const path of albums[userIndex % albums.length]) {
        if (controller.signal.aborted) break;
        pictures.push(await fetch(path));
      }
    }
    // Warm revalidation explicitly checks HTTP 304 after the model was fetched.
    const warm = models[0]?.verified && !controller.signal.aborted ? await fetch(modelPaths[0], true) : null;
    const passed = models.length === 16 && models.every(item => item.verified)
      && pictures.length === images && pictures.every(item => item.verified) && !!warm?.verified;
    return { user: userIndex + 1, startedAtOffsetMs: n3(began - started), models, pictures, warm, firstAssetReadyMs, all16ReadyMs,
      totalJourneyMs: n3(performance.now() - began), validModels: models.filter(item => item.verified).length,
      validImages: pictures.filter(item => item.verified).length, passed };
  }
  let beforePointer, afterPointer, profileError = null;
  try {
    beforePointer = await checkActiveRoute({ port, release, agent, signal: controller.signal });
    assertSafe(beforePointer.passed, 'Active pointer failed pre-journey redirect/HTML integrity');
    const clients = await Promise.allSettled(Array.from({ length: userCount }, (_, i) => journey(i)));
    for (const [i, client] of clients.entries()) {
      if (client.status === 'fulfilled') journeys.push(client.value);
      else {
        profileError = profileError || String(client.reason?.message || client.reason);
        journeys.push({ user: i + 1, passed: false, error: String(client.reason?.code || client.reason?.message || client.reason) });
      }
    }
    if (!controller.signal.aborted) afterPointer = await checkActiveRoute({ port, release, agent, signal: controller.signal });
    else afterPointer = { passed: false, error: 'PROFILE_TIMEOUT' };
  } catch (error) {
    profileError = error.message;
    afterPointer = { passed: false, error: error.message };
  } finally {
    clearTimeout(deadline);
    clearInterval(rssTimer);
    loop.disable();
  }
  const elapsedMs = performance.now() - started, memEnd = process.memoryUsage();
  const cpuDelta = process.cpuUsage(cpuStart), resourceEnd = process.resourceUsage();
  const diskAfter = fileDiskStats(storeDir);
  rssPeak = Math.max(rssPeak, memEnd.rss);
  const objectLatencies = [...pathTimes.values()].flat().filter(Number.isFinite);
  const pathLatency = Object.fromEntries([...pathTimes.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([path, times]) => [path, summary(times.filter(Number.isFinite))]));
  const fullAssetsPerUser = 16 + images;
  const expectedFull = fullAssetsPerUser * userCount, expectedWarm = userCount;
  const requestCountExpected = expectedFull + expectedWarm;
  const passed = !profileError && !controller.signal.aborted && beforePointer?.passed && afterPointer?.passed
    && journeys.length === userCount && journeys.every(item => item.passed)
    && requestStats.offered === requestCountExpected && requestStats.sent === requestCountExpected
    && requestStats.completed === requestCountExpected && requestStats.completed200 === expectedFull
    && requestStats.completed304 === expectedWarm && requestStats.incomplete200 === 0
    && requestStats.failedVerification === 0;
  return {
    virtualHttpClients: userCount, assetsPerClient: { glb: 16, webp: images, conditional304: 1 },
    description: 'virtual HTTP clients: sequential 16 GLB per client, optional 5 WebP, conditional 304; concurrent across clients',
    elapsedMs: n3(elapsedMs), profileTimeout: controller.signal.aborted, profileError,
    expected: { full200: expectedFull, warm304: expectedWarm, total: requestCountExpected },
    requests: requestStats, globalDownloadCap: concurrency, observedPeakInFlight: slots.peak,
    throughput: { actualResponseBodyBytes: requestStats.receivedBodyBytes,
      verified200BodyBytes: requestStats.verifiedBodyBytes,
      actualReceivedMiBps: n3(requestStats.receivedBodyBytes / (elapsedMs / 1000) / 1048576),
      verified200MiBps: n3(requestStats.verifiedBodyBytes / (elapsedMs / 1000) / 1048576),
      definition: 'actual received response bodies divided by wall time including pointer probes and warm requests, not raw socket link capacity' },
    latencyMs: { perObject: summary(objectLatencies), perObjectPath: pathLatency,
      firstAssetReady: summary(journeys.map(item => item.firstAssetReadyMs).filter(Number.isFinite)),
      all16Ready: summary(journeys.map(item => item.all16ReadyMs).filter(Number.isFinite)),
      fullJourney: summary(journeys.map(item => item.totalJourneyMs).filter(Number.isFinite)) },
    activeRoute: { before: beforePointer, after: afterPointer,
      pointerState: readActiveRelease({ storeDir }) },
    resourceUsage: { processRssStartBytes: memStart.rss, processRssEndBytes: memEnd.rss,
      processRssSampledPeakBytes: rssPeak,
      eventLoopLagMs: { p50: n3(loop.percentile(50) / 1e6), p95: n3(loop.percentile(95) / 1e6),
        p99: n3(loop.percentile(99) / 1e6), max: n3(loop.max / 1e6) },
      processCpuUserMs: n3(cpuDelta.user / 1000), processCpuSystemMs: n3(cpuDelta.system / 1000),
      processFsReadOperations: resourceEnd.fsRead - resourceStart.fsRead,
      diskBefore, diskAfter },
    passed, journeys
  };
}

export async function runUserJourneys({ users = [10, 25, 50, 100], images = 0, concurrency = 16,
  maxSeconds = 120, sourceRoot = ROOT, out = null } = {}) {
  validateOptions({ users, images, concurrency, maxSeconds, sourceRoot, out });
  sourceRoot = resolve(sourceRoot);
  if (out && existsSync(out)) throw Object.assign(new Error(`Output already exists; refusing overwrite: ${out}`), { code: 'REPORT_EXISTS' });
  const inventory = validateAssetInventory({ sourceRoot });
  const diskBudget = statfsSync(tmpdir());
  const freeBytes = diskBudget.bavail * diskBudget.bsize;
  assertSafe(freeBytes >= inventory.expectedBytes * 2 + 64 * 1024 * 1024,
    `Insufficient temporary disk space for a real immutable snapshot (${freeBytes} bytes free)`);
  const temp = mkdtempSync(join(tmpdir(), 'velance-p4-fullreal-'));
  const storeDir = join(temp, 'private-releases');
  let server = null, agent = null;
  try {
    const preparedAt = new Date().toISOString();
    const snapshotStart = performance.now();
    const release = await createSnapshot({ sourceRoot, storeDir });
    const snapshotMs = n3(performance.now() - snapshotStart);
    await verifySnapshot({ storeDir, id: release.id });
    await activateRelease({ storeDir, id: release.id });
    const models = count(release.manifest.files, '/assets/models/', '.glb');
    const pictures = count(release.manifest.files, '/assets/images/', '.webp');
    assertSafe(models.length === 16 && pictures.length === 80, 'Snapshot manifest lost real assets (expected 16 GLB and 80 WebP)');
    const manifestPaths = new Set(release.manifest.files.map(file => file.path));
    assertSafe([...inventory.modelPaths, ...inventory.imagePaths].every(path => manifestPaths.has(path)),
      'Release is missing inventory assets');
    const disk = fileDiskStats(storeDir);
    server = createDeliveryServer({ storeDir });
    server.listen(0, HOST);
    await once(server, 'listening');
    agent = new Agent({ keepAlive: true, maxSockets: concurrency, maxFreeSockets: concurrency });
    const profiles = [];
    for (const userCount of users) profiles.push(await runProfile({ userCount, images, concurrency, maxSeconds,
      port: server.address().port, release, modelPaths: inventory.modelPaths, albums: inventory.albums, storeDir, agent }));
    const report = {
      format: 'velance-p4-real-asset-virtual-journeys/1', measuredAtUtc: preparedAt,
      environment: { host: HOST, node: process.version, platform: platform(), arch: arch(),
        cpuModel: cpus()[0]?.model ?? null, logicalCpuCount: cpus().length,
        clientAndServerShareNodeProcess: true },
      config: { virtualHttpUsers: users, optionalWebpPerUser: images, globalInflightLimit: concurrency,
        maxSecondsPerProfile: maxSeconds, perRequestTimeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES, maxEligibleAssetBytes: MAX_TOTAL_ELIGIBLE_ASSET_BYTES,
        protocol: 'HTTP/1.1 plain loopback' },
      assets: { sourceRoot, releasedId: release.id, snapshotMs, totalSnapshotFiles: release.manifest.files.length,
        models: inventory.modelCount, carWebpImages: inventory.imageCount, totalModelBytesPerUser: inventory.allModelBytes,
        totalEligibleModelAndImageBytes: inventory.expectedBytes, totalModelMiBPerUser: n3(inventory.allModelBytes / 1048576),
        albumSelection: 'one deterministic five-WebP folder per user, rotating through 16 folders', disk },
      profiles, passed: profiles.every(profile => profile.passed),
      caveats: [
        'All assets are real on-disk showroom files copied unchanged into a private temporary release; source assets are never modified.',
        'Virtual users issue sequential HTTP downloads and overlap through a global semaphore; they do not create browser tabs, WebGL contexts or GPU work.',
        '100 virtual HTTP clients do NOT represent 100 real browsers, users, CDN edge connections or a globally served audience.',
        'Single process hosts both HTTP client and preview server, so RSS, event-loop lag and CPU are combined measurements.',
        'HTTP SHA256 is checked on each completed asset against the immutable manifest; P3 server also hashes release files per request.',
        'Throughput includes received response payload bytes over end-to-end wall duration; excludes request/response headers, TCP overhead and TLS.',
        'Read volume may be satisfied by OS cache, so apparent snapshot bytes and filesystem availability are not actual physical disk throughput.',
        'This tests immutable local HTTP delivery and cache policy, not real browser loading, user interactions, WAN, WAF, or CDN infrastructure.'
      ]
    };
    if (out) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return report;
  } finally {
    agent?.destroy();
    if (server?.listening) await server.shutdown();
    rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const options = parseJourneyArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Local P4 REAL-asset virtual HTTP journey benchmark.\nUsage: node tools/perf/p4_user_journeys.mjs --users 10,25,50,100 --images 5 --concurrency 16 --max-seconds 120 --out /tmp/p4-user-journeys.json\nSmoke: --users 1 --images 0 --concurrency 2 --out /tmp/p4-smoke.json\nLimits: users individually from 1,10,25,50,100 only; <=100 users, <=32 inflight, <=240 seconds/profile. Output must not exist.\n');
    } else {
      const report = await runUserJourneys(options);
      process.stdout.write(`${JSON.stringify({ format: report.format, release: report.assets.releasedId,
        modelBytesPerVisit: report.assets.totalModelBytesPerUser,
        profiles: report.profiles.map(profile => ({ users: profile.virtualHttpClients, passed: profile.passed,
          offered: profile.requests.offered, sent: profile.requests.sent, completed: profile.requests.completed,
          incomplete200: profile.requests.incomplete200, failures: profile.requests.failuresByCode,
          p95ObjectMs: profile.latencyMs.perObject.p95, p95FullJourneyMs: profile.latencyMs.fullJourney.p95,
          actualMiBps: profile.throughput.actualReceivedMiBps, peakInFlight: profile.observedPeakInFlight })),
        passed: report.passed, out: options.out }, null, 2)}\n`);
      if (!report.passed) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`[P4 virtual journeys] ${error.code || 'ERROR'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
