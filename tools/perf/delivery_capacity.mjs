// Bounded, fixture-only P4 delivery capacity probe. This is a loopback HTTP benchmark,
// not a CDN, WAN, multi-machine, browser-cache, or production capacity measurement.
// Usage: node tools/perf/delivery_capacity.mjs --duration 10s --rps 10 --concurrency 16 --out /tmp/delivery-capacity.json
import { createServer as createHttpServer, request as httpRequest, Agent } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createSnapshot, activateRelease } from '../delivery/release.mjs';
import { createDeliveryServer } from '../delivery/server.mjs';

const HOST = '127.0.0.1';
const MODES = ['uncached', 'warm', 'identity'];
const LIMITS = Object.freeze({ maxSeconds: 30, maxRps: 40, maxConcurrency: 32, maxRequestsPerMode: 1200,
  maxResponseBytes: 2 * 1024 * 1024, requestTimeoutMs: 4000, lagPeriodsToSkip: 1.5 });
const MIME = Object.freeze({ html: 'text/html', js: 'text/javascript', glb: 'model/gltf-binary', webp: 'image/webp' });
const RESOURCES = Object.freeze([
  { kind: 'html', path: '/index.html', acceptEncoding: 'br, gzip;q=0.5, identity;q=0.1', expectedEncoding: 'br' },
  { kind: 'js', path: '/src/app.js', acceptEncoding: 'gzip, br;q=0.5, identity;q=0.1', expectedEncoding: 'gzip' },
  { kind: 'glb', path: '/assets/models/synthetic.glb', acceptEncoding: 'identity', expectedEncoding: 'identity' },
  { kind: 'webp', path: '/assets/images/synthetic/angle.webp', acceptEncoding: 'identity', expectedEncoding: 'identity' }
]);
const round = (value, places = 3) => Number.isFinite(value) ? +value.toFixed(places) : null;
const fail = message => { throw new Error(message); };
const sleep = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));

export function parseCapacityArgs(args) {
  const options = { durationSeconds: 10, rps: 10, concurrency: 16, out: null };
  const flags = { '--duration': 'durationSeconds', '--rps': 'rps', '--concurrency': 'concurrency', '--out': 'out' };
  const seen = new Set();
  if (args.includes('--help')) {
    if (args.length !== 1) fail('--help cannot be combined with other arguments');
    return { help: true };
  }
  for (let i = 0; i < args.length; i += 2) {
    const arg = args[i], field = flags[arg], value = args[i + 1];
    if (!field || seen.has(arg) || typeof value !== 'string' || !value || value.startsWith('--')) fail(`Unknown, duplicate, or missing value for ${arg}`);
    seen.add(arg);
    if (field === 'durationSeconds') {
      if (!/^[1-9]\d*s$/.test(value)) fail('--duration must be an integer number of seconds such as 10s');
      options.durationSeconds = Number(value.slice(0, -1));
    } else if (field === 'out') options.out = resolve(value);
    else {
      if (!/^[1-9]\d*$/.test(value)) fail(`${arg} must be a positive integer`);
      options[field] = Number(value);
    }
  }
  validateOptions(options);
  return options;
}

function validateOptions({ durationSeconds, rps, concurrency }) {
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > LIMITS.maxSeconds)
    fail(`durationSeconds must be 1..${LIMITS.maxSeconds}`);
  if (!Number.isSafeInteger(rps) || rps < 1 || rps > LIMITS.maxRps) fail(`rps must be 1..${LIMITS.maxRps}`);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > LIMITS.maxConcurrency)
    fail(`concurrency must be 1..${LIMITS.maxConcurrency}`);
  if (durationSeconds * rps > LIMITS.maxRequestsPerMode) fail('Offered requests exceed the per-mode safety cap');
}

function percentile(values, q) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return round(ordered[Math.min(ordered.length - 1, Math.floor(q * ordered.length))]);
}
function latencySummary(values) {
  return { samples: values.length, p50: percentile(values, .50), p95: percentile(values, .95),
    p99: percentile(values, .99), max: values.length ? round(Math.max(...values)) : null };
}
function headerBytes(res) {
  const statusLine = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}\r\n`;
  const pairs = res.rawHeaders;
  let bytes = Buffer.byteLength(statusLine) + 2;
  for (let i = 0; i < pairs.length; i += 2) bytes += Buffer.byteLength(`${pairs[i]}: ${pairs[i + 1]}\r\n`);
  return bytes;
}
function responseHeaders(headers) {
  return Object.fromEntries(['cache-control', 'vary', 'etag', 'content-type', 'content-encoding',
    'content-length', 'x-content-type-options', 'cross-origin-resource-policy'].map(key => [key, headers[key] ?? null]));
}

// Read incrementally. Never collect bodies or queue more than `concurrency` requests.
function fetchLocal({ port, path, headers = {}, method = 'GET', body = null, agent = false }) {
  return new Promise(resolveResult => {
    const sentAt = performance.now();
    let settled = false, req;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolveResult({ ...result, latencyMs: round(performance.now() - sentAt) });
    };
    req = httpRequest({ hostname: HOST, port, path, method, agent,
      headers: { ...headers, ...(body === null ? {} : { 'Content-Length': Buffer.byteLength(body) }) } }, res => {
      let bodyBytes = 0;
      const headersBytes = headerBytes(res);
      const common = () => ({ status: res.statusCode, headers: responseHeaders(res.headers),
        bodyBytes, estimatedHttp1HeaderBytes: headersBytes, complete: !!res.complete, error: null });
      res.on('data', chunk => {
        bodyBytes += chunk.length;
        if (bodyBytes > LIMITS.maxResponseBytes) res.destroy(new Error('RESPONSE_TOO_LARGE'));
      });
      res.once('error', error => finish({ ...common(), complete: false, error: error.message === 'RESPONSE_TOO_LARGE'
        ? 'RESPONSE_TOO_LARGE' : error.code || 'RESPONSE_STREAM_ERROR' }));
      res.once('end', () => finish(common()));
      res.once('close', () => { if (!res.complete) finish({ ...common(), complete: false, error: 'RESPONSE_ABORTED' }); });
    });
    req.once('error', error => finish({ status: null, headers: null, bodyBytes: 0,
      estimatedHttp1HeaderBytes: 0, complete: false, error: error.code || 'REQUEST_ERROR' }));
    req.setTimeout(LIMITS.requestTimeoutMs, () => req.destroy(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })));
    req.end(body ?? undefined);
  });
}

function seededBytes(size, seed) {
  const result = Buffer.allocUnsafe(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    result[i] = x & 255;
  }
  return result;
}
function syntheticGlb() {
  const binary = seededBytes(384 * 1024, 0x45f0a911);
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0', generator: 'VELANCE synthetic capacity fixture' },
    buffers: [{ byteLength: binary.length }] }));
  const jsonPadded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(jsonPadded);
  const data = Buffer.allocUnsafe(12 + 8 + jsonPadded.length + 8 + binary.length);
  data.write('glTF', 0, 'ascii'); data.writeUInt32LE(2, 4); data.writeUInt32LE(data.length, 8);
  data.writeUInt32LE(jsonPadded.length, 12); data.write('JSON', 16, 'ascii'); jsonPadded.copy(data, 20);
  const offset = 20 + jsonPadded.length;
  data.writeUInt32LE(binary.length, offset); data.write('BIN\0', offset + 4, 'binary'); binary.copy(data, offset + 8);
  return data;
}
function syntheticWebpPayload() {
  // A deterministic RIFF/WEBP-shaped transfer surrogate; this runner does not decode images.
  const payload = seededBytes(96 * 1024, 0x00abc777), file = Buffer.allocUnsafe(payload.length + 20);
  file.write('RIFF', 0, 'ascii'); file.writeUInt32LE(file.length - 8, 4);
  file.write('WEBP', 8, 'ascii'); file.write('VP8 ', 12, 'ascii'); file.writeUInt32LE(payload.length, 16);
  payload.copy(file, 20);
  return file;
}
function buildFixture(root) {
  const files = {
    'index.html': Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Synthetic release</title></head>
      <body><main>Local loopback delivery fixture</main><script type="module" src="/src/app.js"></script></body></html>\n${'<!-- synthetic -->\n'.repeat(200)}`),
    'src/app.js': Buffer.from(`// generated synthetic source for HTTP compression only\nexport const measurement = [\n${Array.from({ length: 350 }, (_, i) => `  "synthetic HTTP compression fixture ${i}"`).join(',\n')}\n];\n`),
    'assets/models/synthetic.glb': syntheticGlb(),
    'assets/images/synthetic/angle.webp': syntheticWebpPayload()
  };
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  return { fileCount: Object.keys(files).length, sourceBytes: Object.values(files).reduce((n, b) => n + b.length, 0),
    sizes: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, bytes.length])) };
}

function inspectDisk(path) {
  let apparentBytes = 0, regularFiles = 0;
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) { apparentBytes += statSync(target).size; regularFiles++; }
    }
  }
  walk(path);
  let availableBytes = null;
  try { const stat = statfsSync(path); availableBytes = stat.bavail * stat.bsize; } catch {}
  return { apparentBytes, regularFiles, filesystemAvailableBytes: availableBytes };
}

function scenarioResource(mode, index) {
  return mode === 'identity' ? RESOURCES[2 + index % 2] : RESOURCES[index % RESOURCES.length];
}
function requestHeaders(resource, mode, etags) {
  const result = { 'Accept-Encoding': resource.acceptEncoding };
  if (mode === 'uncached') result['Cache-Control'] = 'no-cache';
  if (mode === 'warm') result['If-None-Match'] = etags.get(resource.kind);
  return result;
}
function checkPolicy(mode, resource, record) {
  if (record.error || !record.complete) return record.error || 'RESPONSE_INCOMPLETE';
  const expectedStatus = mode === 'warm' ? 304 : 200;
  if (record.status !== expectedStatus) return `EXPECTED_${expectedStatus}_GOT_${record.status}`;
  if (record.headers['cache-control'] !== 'public, max-age=31536000, immutable') return 'BAD_IMMUTABLE_CACHE_CONTROL';
  if (record.headers.vary !== 'Accept-Encoding') return 'BAD_VARY';
  if (!/^"[a-f0-9]{64}-(?:identity|gzip|br)"$/.test(record.headers.etag || '')) return 'BAD_ETAG';
  if (record.headers['x-content-type-options'] !== 'nosniff') return 'BAD_NOSNIFF';
  if (record.headers['cross-origin-resource-policy'] !== 'same-origin') return 'BAD_CORP';
  if (!record.headers['content-type']?.startsWith(MIME[resource.kind])) return 'BAD_MIME';
  if (mode === 'warm') {
    if (record.bodyBytes !== 0 || record.headers['content-length'] !== null) return '304_HAS_BODY_OR_LENGTH';
    if (resource.expectedEncoding !== 'identity' && record.headers['content-encoding'] !== resource.expectedEncoding)
      return '304_BAD_CONTENT_ENCODING';
    if (resource.expectedEncoding === 'identity' && record.headers['content-encoding'] !== null)
      return '304_BINARY_COMPRESSED';
    return null;
  }
  if (resource.expectedEncoding === 'identity' && record.headers['content-encoding'] != null) return 'BINARY_COMPRESSED';
  if (resource.expectedEncoding !== 'identity' && record.headers['content-encoding'] !== resource.expectedEncoding) return 'BAD_CONTENT_ENCODING';
  if (record.headers['content-length'] === null || Number(record.headers['content-length']) !== record.bodyBytes) return 'BAD_CONTENT_LENGTH';
  return null;
}
function statusBand(code) { return code == null ? 'transport' : `${Math.floor(code / 100)}xx`; }

async function runScenario({ port, id, mode, durationSeconds, rps, concurrency, etags, agent }) {
  const total = durationSeconds * rps, interval = 1000 / rps, pending = new Set();
  const statuses = { 200: 0, 304: 0, 429: 0, 503: 0 }, bands = {};
  const byResource = Object.fromEntries(RESOURCES.map(resource => [resource.kind, { sent: 0, completed: 0, bodyBytes: 0, headerBytes: 0 }]));
  const samples = [], samplesScheduled = [], samplesSuccess = [], errors = {}, policyViolations = {};
  const headersObserved = {};
  let sent = 0, completed = 0, transportErrors = 0, shedConcurrency = 0, shedLag = 0, peakConcurrency = 0;
  let receivedBodyBytes = 0, estimatedHttp1HeaderBytes = 0;
  const before = process.memoryUsage(), cpuBefore = process.cpuUsage();
  let peakRss = before.rss;
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const rssInterval = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
  const started = performance.now();
  try {
    for (let i = 0; i < total; i++) {
      const scheduled = started + i * interval;
      await sleep(scheduled - performance.now());
      const lag = performance.now() - scheduled;
      if (lag > LIMITS.lagPeriodsToSkip * interval) { shedLag++; continue; }
      if (pending.size >= concurrency) { shedConcurrency++; continue; }
      const resource = scenarioResource(mode, i), path = `/r/${id}${resource.path}`;
      sent++; byResource[resource.kind].sent++;
      const task = fetchLocal({ port, path, headers: requestHeaders(resource, mode, etags), agent }).then(record => {
        const kind = byResource[resource.kind];
        if (record.status != null) {
          statuses[record.status] = (statuses[record.status] || 0) + 1;
          bands[statusBand(record.status)] = (bands[statusBand(record.status)] || 0) + 1;
        }
        receivedBodyBytes += record.bodyBytes;
        estimatedHttp1HeaderBytes += record.estimatedHttp1HeaderBytes;
        kind.bodyBytes += record.bodyBytes;
        kind.headerBytes += record.estimatedHttp1HeaderBytes;
        if (record.complete && !record.error) {
          completed++; kind.completed++;
          samples.push(record.latencyMs);
          samplesScheduled.push(round(performance.now() - scheduled));
          if (record.status === (mode === 'warm' ? 304 : 200)) samplesSuccess.push(record.latencyMs);
        } else {
          transportErrors++;
          const code = record.error || 'INCOMPLETE'; errors[code] = (errors[code] || 0) + 1;
        }
        const policy = mode === 'warm' && record.headers && record.headers.etag !== etags.get(resource.kind)
          ? 'ETAG_CHANGED' : checkPolicy(mode, resource, record);
        if (policy) policyViolations[policy] = (policyViolations[policy] || 0) + 1;
        if (record.headers && !headersObserved[resource.kind]) headersObserved[resource.kind] = {
          status: record.status, ...record.headers };
      }).finally(() => pending.delete(task));
      pending.add(task);
      peakConcurrency = Math.max(peakConcurrency, pending.size);
    }
    const scheduledElapsedMs = performance.now() - started;
    await Promise.all(pending);
    const wallMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore), after = process.memoryUsage();
    peakRss = Math.max(peakRss, after.rss);
    const result = {
      mode, definition: mode === 'warm' ? 'conditional GET with primed ETag; HTTP 304, no payload' : mode === 'identity'
        ? 'unconditional binary GET (GLB/WebP), Accept-Encoding: identity' : 'unconditional GET, no client cache, HTML Brotli / JS gzip / binary identity',
      load: { targetRps: rps, durationSeconds, concurrencyLimit: concurrency, offered: total, sent, completed,
        transportErrors, shedConcurrency, shedSchedulerLag: shedLag, refusedBeforeSend: total - sent,
        peakInFlight: peakConcurrency,
        observedCompletionRps: round(completed / Math.max(durationSeconds, wallMs / 1000)),
        offeredWindowMs: durationSeconds * 1000, scheduleMs: round(scheduledElapsedMs), totalWallMs: round(wallMs) },
      statusCounts: statuses, statusClasses: bands,
      httpErrors: { status429: statuses[429], status503: statuses[503],
        other4xx5xx: Object.entries(statuses).filter(([code]) => Number(code) >= 400 && ![429, 503].includes(Number(code))).reduce((n, [, count]) => n + count, 0) },
      latencyMs: { completed: latencySummary(samples), expectedStatus: latencySummary(samplesSuccess),
        scheduledToComplete: latencySummary(samplesScheduled) },
      transfer: { actualBodyBytes: receivedBodyBytes, estimatedHttp1HeaderBytes,
        estimatedHttp1TotalBytes: receivedBodyBytes + estimatedHttp1HeaderBytes,
        meanBodyBytesPerCompleted: completed ? round(receivedBodyBytes / completed) : null,
        excludes: 'TCP/IP framing, packets, request headers, TLS; response header size reconstructed from rawHeaders' },
      byResource, headersObserved, policyViolations, transportErrorCodes: errors,
      resources: { processRssBeforeBytes: before.rss, processRssAfterBytes: after.rss, processPeakRssBytes: peakRss,
        processHeapAfterBytes: after.heapUsed,
        cpuUserMs: round(cpu.user / 1000), cpuSystemMs: round(cpu.system / 1000),
        eventLoopDelayMs: { p50: round(loop.percentile(50) / 1e6), p95: round(loop.percentile(95) / 1e6),
          p99: round(loop.percentile(99) / 1e6), max: round(loop.max / 1e6) } }
    };
    return result;
  } finally { clearInterval(rssInterval); loop.disable(); }
}

async function assertStaticWhenUpstreamDown(storeDir, releaseId) {
  // Reserve an ephemeral loopback port, close it, then point the preview proxy at
  // that currently unavailable endpoint. This is an isolated failure probe.
  const occupied = createHttpServer();
  occupied.listen(0, HOST); await once(occupied, 'listening');
  const unavailablePort = occupied.address().port;
  await new Promise(done => occupied.close(done));
  const preview = createDeliveryServer({ storeDir, upstream: `http://${HOST}:${unavailablePort}` });
  try {
    preview.listen(0, HOST); await once(preview, 'listening');
    const port = preview.address().port;
    const staticReply = await fetchLocal({ port, path: `/r/${releaseId}/index.html`, headers: { 'Accept-Encoding': 'identity' } });
    const telemetryReply = await fetchLocal({ port, path: '/api/telemetry', method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json' } });
    return { upstream: 'unavailable loopback port (no DB)', staticStatus: staticReply.status,
      staticComplete: staticReply.complete, telemetryStatus: telemetryReply.status,
      telemetryComplete: telemetryReply.complete,
      passed: staticReply.status === 200 && staticReply.complete && telemetryReply.status === 503 && telemetryReply.complete };
  } finally { if (preview.listening) await preview.shutdown(); }
}

async function runConcurrentProbe({ port, id, concurrency, agent }) {
  // A distinct bounded burst exercises N outstanding GLB SHA256 verifications.
  // It has no target RPS and is explicitly excluded from steady-state metrics.
  const path = `/r/${id}/assets/models/synthetic.glb`;
  const memoryBefore = process.memoryUsage(), cpuBefore = process.cpuUsage();
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const started = performance.now();
  let records;
  try {
    records = await Promise.all(Array.from({ length: concurrency }, () => fetchLocal({
      port, path, headers: { 'Accept-Encoding': 'identity' }, agent
    })));
  } finally { loop.disable(); }
  const memoryAfter = process.memoryUsage(), cpu = process.cpuUsage(cpuBefore);
  const statuses = { 200: 0, 429: 0, 503: 0 }, violations = {};
  let completed = 0, bodyBytes = 0, headerBytes = 0;
  const timings = [];
  for (const response of records) {
    if (response.status != null) statuses[response.status] = (statuses[response.status] || 0) + 1;
    const violation = checkPolicy('identity', RESOURCES[2], response);
    if (violation) violations[violation] = (violations[violation] || 0) + 1;
    if (response.complete && !response.error) { completed++; timings.push(response.latencyMs); }
    bodyBytes += response.bodyBytes;
    headerBytes += response.estimatedHttp1HeaderBytes;
  }
  return { kind: 'simultaneous-client-requests', resource: 'synthetic GLB',
    reason: 'exercise concurrent per-request SHA256 file checks, outside rate-controlled scenarios',
    offered: concurrency, sent: concurrency, completed, clientRequestsDispatchedTogether: concurrency,
    statuses, policyViolations: violations, latencyMs: latencySummary(timings), elapsedMs: round(performance.now() - started),
    actualBodyBytes: bodyBytes, estimatedHttp1HeaderBytes: headerBytes,
    resources: { processRssBeforeBytes: memoryBefore.rss, processRssAfterBytes: memoryAfter.rss,
      processRssObservedMaxBytes: Math.max(memoryBefore.rss, memoryAfter.rss),
      cpuUserMs: round(cpu.user / 1000), cpuSystemMs: round(cpu.system / 1000),
      eventLoopDelayP99Ms: round(loop.percentile(99) / 1e6) },
    caveat: 'Client dispatch fan-out is bounded by the agent socket cap; server-level concurrency is not directly measured.' };
}

export async function runDeliveryCapacity({ durationSeconds = 10, rps = 10, concurrency = 16, out = null } = {}) {
  validateOptions({ durationSeconds, rps, concurrency });
  if (out !== null && (typeof out !== 'string' || !out.trim())) fail('out must be a path or null');
  const temp = mkdtempSync(join(tmpdir(), 'velance-p4-capacity-'));
  const sourceRoot = join(temp, 'synthetic-source'), storeDir = join(temp, 'synthetic-store');
  mkdirSync(sourceRoot);
  const startedAt = new Date().toISOString();
  let preview, agent;
  try {
    const fixture = buildFixture(sourceRoot);
    const release = await createSnapshot({ sourceRoot, storeDir });
    await activateRelease({ storeDir, id: release.id });
    const diskBefore = inspectDisk(temp);
    preview = createDeliveryServer({ storeDir });
    preview.listen(0, HOST); await once(preview, 'listening');
    const port = preview.address().port;
    agent = new Agent({ keepAlive: true, maxSockets: concurrency, maxFreeSockets: concurrency });

    // Four explicit representation ETags are obtained before measuring warm 304.
    // Priming cost is accounted separately and never hidden inside throughput.
    const etags = new Map(), priming = { requests: 0, bodyBytes: 0, estimatedHttp1HeaderBytes: 0, headers: {} };
    for (const resource of RESOURCES) {
      const response = await fetchLocal({ port, path: `/r/${release.id}${resource.path}`,
        headers: { 'Accept-Encoding': resource.acceptEncoding }, agent });
      const policy = checkPolicy('uncached', resource, response);
      if (policy) fail(`Fixture priming failed for ${resource.kind}: ${policy}`);
      etags.set(resource.kind, response.headers.etag);
      priming.requests++;
      priming.bodyBytes += response.bodyBytes;
      priming.estimatedHttp1HeaderBytes += response.estimatedHttp1HeaderBytes;
      priming.headers[resource.kind] = response.headers;
    }
    const modes = [];
    for (const mode of MODES) modes.push(await runScenario({ port, id: release.id, mode, durationSeconds, rps, concurrency, etags, agent }));
    const concurrencyProbe = await runConcurrentProbe({ port, id: release.id, concurrency, agent });
    agent.destroy(); agent = null;
    await preview.shutdown(); preview = null;
    const upstreamOutage = await assertStaticWhenUpstreamDown(storeDir, release.id);
    const diskAfter = inspectDisk(temp);
    const result = {
      format: 'velance-p4-delivery-capacity/1', measuredAtUtc: startedAt,
      environment: { node: process.version, platform: platform(), arch: arch(),
        cpuModel: cpus()[0]?.model ?? null, logicalCpus: cpus().length, host: HOST,
        clientAndServerInSameProcess: true },
      config: { durationSecondsPerMode: durationSeconds, targetRpsPerMode: rps, maxConcurrency: concurrency,
        totalOfferedSteadyState: durationSeconds * rps * MODES.length,
        separateConcurrencyProbeOffers: concurrency, maxResponseBytes: LIMITS.maxResponseBytes,
        requestTimeoutMs: LIMITS.requestTimeoutMs, maxDurationSecondsPerMode: LIMITS.maxSeconds,
        modes: MODES, rateModel: 'open-loop scheduled arrivals; late arrivals shed instead of burst replay' },
      fixture: { source: 'generated in private OS temp directory; no repository assets read', ...fixture,
        releaseId: release.id, snapshotFiles: release.manifest.files.length,
        releaseBytes: release.manifest.files.reduce((n, file) => n + file.bytes, 0), diskBefore, diskAfter,
        binaryWebpIsTransferSurrogate: true },
      priming, modes, concurrencyProbe, upstreamOutage,
      caveats: [
        'Only local 127.0.0.1 HTTP/1.1. This does not measure CDN POPs, external clients, WAF, TLS, WAN latency, or global throughput.',
        'The client and P3 preview run in the same Node process and compete for CPU, RSS and event loop; resource numbers are combined.',
        'Uncached means an unconditional request with no client HTTP cache; the server may reuse its own compressed-representation cache.',
        'Warm uses If-None-Match/304 to model conditional HTTP revalidation; actual CDN/browser cache hits often generate no HTTP request.',
        'p50/p95/p99 are observed sample quantiles at the offered load; small test samples have low confidence and cannot establish user capacity.',
        'HTTP bytes include actual received response payload, plus an estimate of serialized HTTP/1.1 response headers, excluding TCP/IP.',
        'GLB and WebP assets are synthetic binary payloads for transfer tests; browser decoding, streaming 3D and GPU performance are not measured.',
        'Release-file SHA256 verification happens on every served request, including GLB; OS page cache may satisfy disk reads.',
        'RSS in timed modes is sampled every 100 ms plus beginning/end; very short peaks may be missed. The burst records beginning/end RSS only.',
        'The separate simultaneous GLB burst checks fan-out under the configured cap but is not a steady-state target-RPS result.'
      ]
    };
    if (out) {
      const output = resolve(out);
      // Explicit output is create-only; protect previously collected benchmark evidence.
      writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    return result;
  } finally {
    agent?.destroy();
    if (preview?.listening) await preview.shutdown();
    rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = parseCapacityArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write('node tools/perf/delivery_capacity.mjs [--duration 10s] [--rps 10] [--concurrency 16] [--out /tmp/delivery-capacity.json]\nLimits: 1..30s per mode; 1..40 RPS; 1..32 concurrent; 1200 offers per mode. Runs uncached, warm 304 and identity. Output file must not already exist.\n');
    } else {
      const result = await runDeliveryCapacity(args);
      const summary = { format: result.format, config: result.config, fixture: { fileCount: result.fixture.fileCount,
        releaseBytes: result.fixture.releaseBytes, diskBefore: result.fixture.diskBefore,
        diskAfter: result.fixture.diskAfter },
      modes: result.modes.map(({ mode, load, statusCounts, httpErrors, latencyMs, transfer, policyViolations, resources }) => ({
        mode, load, statusCounts, httpErrors, latencyMs, transfer, policyViolations, resources })),
      concurrencyProbe: result.concurrencyProbe, upstreamOutage: result.upstreamOutage,
      report: args.out ?? 'stdout summary only' };
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`[P4 delivery capacity] ${error.message}\n`);
    process.exitCode = 1;
  }
}
