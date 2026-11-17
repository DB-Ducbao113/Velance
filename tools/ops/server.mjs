import { createServer } from 'node:http';
import { statSync, statfsSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createDatabase } from './db-worker.mjs';
import { createLogger, createMetrics, startBackupScheduler } from './operations.mjs';
import { serveStatic as serveStaticDelivery } from '../delivery/static.mjs';
import { applySecurityHeaders } from '../delivery/security-headers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CAP = 256 * 1024, UPLOAD_CAP = 16 * 1024 * 1024;
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
const HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const BACKENDS = new Set(['webgpu', 'webgl2', 'images']);
const PHASES = new Set(['boot', 'home-idle', 'browse', 'flight', 'overview', 'selected-orbit', 'selected-idle']);
const EVENTS = new Set(['error', 'engineError', 'selectCar', 'overviewBtn', 'rowBtn', 'backToGarageTop', 'backToGarage', 'zoomReset', 'paint']);
const MILESTONES = ['gateShown', 'enter', 'firstFrame', 'firstCar', 'allLoaded'];
const SAMPLE_FIELDS = ['t', 'phase', 'fps', 'renderAvg', 'renderP95', 'drawCalls', 'triangles', 'loaded', 'heapMB', 'pixelRatio'];
const STAT_NUMBERS = ['focus', 'selected', 'row', 'loaded', 'total', 'bays', 'queued', 'fps', 'renderMsAvg', 'renderMsP95', 'drawCalls', 'reflectorDraws', 'triangles', 'pixelRatio', 'geometries', 'textures', 'programs', 'firstFrameMs', 'heapMB'];
const COUNTERS = new Set(['focus', 'selected', 'row', 'loaded', 'total', 'bays', 'queued', 'drawCalls', 'reflectorDraws', 'triangles', 'geometries', 'textures', 'programs']);
const ROUTES = new Set(['/api/telemetry', '/api/summary', '/api/sessions', '/health/live', '/health/ready', '/metrics']);
const routeOf = path => ROUTES.has(path) ? path : path.startsWith('/api/sessions/') ? '/api/sessions/:id' : path.startsWith('/api/') ? '/api/other' : 'static';
const rejectionClass = status => status === 429 ? 'overload' : status === 503 ? 'unavailable' : status >= 500 ? 'server' : 'client';

function fail(status, code) { throw Object.assign(new Error(code), { status, code }); }
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail(400, 'BAD_SHAPE');
  return value;
}
function number(value, integer = false, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(value))) fail(400, 'BAD_NUMBER');
  return value;
}
function string(value, max) {
  if (typeof value !== 'string' || value.length > max) fail(400, 'BAD_STRING');
  return value;
}
function enumeration(value, values, nullable = false) {
  if (value == null && nullable) return null;
  if (!values.has(value)) fail(400, 'BAD_ENUM');
  return value;
}
function boolean(value) { if (typeof value !== 'boolean') fail(400, 'BAD_BOOLEAN'); return value; }
function validate(batch) {
  fields(batch, ['id', 'seq', 'startedAt', 'context', 'milestones', 'backend', 'final', 'samples', 'events']);
  if (!ID_RE.test(string(batch.id, 64))) fail(400, 'BAD_ID');
  number(batch.seq, true, true);
  number(batch.startedAt, true, true);
  const milestones = fields(batch.milestones, MILESTONES);
  const normalized = { ...batch, backend: enumeration(batch.backend, BACKENDS, true), milestones: Object.fromEntries(MILESTONES.map(k => [k, number(milestones[k], true)])) };
  if (batch.context != null) {
    const c = fields(batch.context, ['ua', 'mobile', 'screen', 'dpr', 'cores', 'memory', 'net', 'webgpu', 'reduced']);
    for (const [k, v] of Object.entries(c)) {
      if (['mobile', 'webgpu', 'reduced'].includes(k)) boolean(v);
      else if (k === 'ua') string(v, 512);
      else if (k === 'screen') { if (!/^\d{1,6}x\d{1,6}$/.test(string(v, 13))) fail(400, 'BAD_SCREEN'); }
      else if (k === 'net') enumeration(v, new Set(['slow-2g', '2g', '3g', '4g']), true);
      else number(v, k === 'cores');
    }
  }
  if (batch.final != null) {
    fields(batch.final, ['duration', 'stats']);
    number(batch.final.duration, true, true);
    if (batch.final.stats != null) {
      const stats = fields(batch.final.stats, [...STAT_NUMBERS, 'backend', 'mode', 'overview', 'loadTimes']);
      for (const [k, v] of Object.entries(stats)) {
        if (k === 'backend') enumeration(v, BACKENDS);
        else if (k === 'mode') enumeration(v, new Set(['home', 'selected']));
        else if (k === 'overview') boolean(v);
        else if (k === 'loadTimes') {
          if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > 64) fail(400, 'BAD_LOAD_TIMES');
          for (const [id, t] of Object.entries(v)) {
            if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) fail(400, 'BAD_CAR_ID');
            number(t, false, true);
          }
        } else number(v, COUNTERS.has(k));
      }
    }
  }
  for (const [key, max] of [['samples', 2000], ['events', 500]]) if (!Array.isArray(batch[key]) || batch[key].length > max) fail(400, 'BAD_ARRAY');
  for (const s of batch.samples) {
    fields(s, SAMPLE_FIELDS);
    number(s.t, true, true); enumeration(s.phase, PHASES);
    for (const k of SAMPLE_FIELDS.slice(2)) number(s[k], COUNTERS.has(k));
  }
  for (const e of batch.events) {
    fields(e, ['t', 'type', 'data']);
    number(e.t, true, true); enumeration(e.type, EVENTS);
    if (e.data != null) {
      fields(e.data, e.type === 'paint' ? ['i'] : ['error', 'engineError'].includes(e.type) ? ['msg'] : []);
      if ('msg' in e.data) string(e.data.msg, 300);
      if ('i' in e.data) { number(e.data.i, true, true); if (e.data.i > 6) fail(400, 'BAD_PAINT_INDEX'); }
    }
  }
  return normalized;
}

function json(res, status, value, headers = {}) {
  if (res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((ok, no) => {
    let size = 0, done = false;
    const chunks = [];
    const reject = error => { if (done) return; done = true; clearTimeout(timer); chunks.length = 0; no(error); };
    const timer = setTimeout(() => reject(Object.assign(new Error('UPLOAD_TIMEOUT'), { status: 408, code: 'UPLOAD_TIMEOUT' })), 5000);
    req.on('error', reject);
    req.once('aborted', () => reject(Object.assign(new Error('ABORTED_BODY'), { status: 400, code: 'ABORTED_BODY' })));
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > CAP) { reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { status: 413, code: 'PAYLOAD_TOO_LARGE' })); return; }
      chunks.push(chunk);
    });
    req.once('end', () => { if (!done) { done = true; clearTimeout(timer); ok(Buffer.concat(chunks)); } });
  });
}
export async function createOpsServer({ root = ROOT, dbPath = resolve(ROOT, 'tools/ops/telemetry.db'), log = () => {}, backupDir = null, backupIntervalMs = 3600000, backupKeep = 168 } = {}) {
  root = realpathSync(root);
  dbPath = resolve(dbPath);
  const metrics = createMetrics();
  const counter = (name, help) => metrics.counter(name, help), gauge = (name, help) => metrics.gauge(name, help);
  const m = {
    requests: counter('velance_http_requests_total', 'HTTP requests by route template, method and status.'),
    duration: metrics.histogram('velance_http_request_duration_seconds', 'HTTP request latency by route template and method.'),
    rejections: counter('velance_http_rejections_total', 'Rejected HTTP requests by error code and class.'),
    ingest: counter('velance_ingest_batches_total', 'Acknowledged telemetry batches by result.'),
    dbOps: counter('velance_db_operations_total', 'Database worker operations by kind and result.'),
    dbDuration: metrics.histogram('velance_db_operation_duration_seconds', 'Database worker execution time by kind.'),
    summaryCache: counter('velance_summary_cache_total', 'Summary cache lookups by result.'),
    backups: counter('velance_backups_total', 'Scheduled backup attempts by result.'),
    logsDropped: counter('velance_log_lines_dropped_total', 'Request log lines dropped by the log rate limiter.'),
    ready: gauge('velance_ready', '1 when the service accepts telemetry.'),
    draining: gauge('velance_draining', '1 while the service drains for shutdown.'),
    workerUp: gauge('velance_db_worker_up', 'Database worker health by role.'),
    queueJobs: gauge('velance_db_queue_jobs', 'Queued and running database jobs by role.'),
    queueBytes: gauge('velance_db_queue_bytes', 'Reserved database queue bytes by role.'),
    queueJobLimit: gauge('velance_db_queue_job_limit', 'Database queue job limit by role.'),
    queueByteLimit: gauge('velance_db_queue_byte_limit', 'Database queue byte limit by role.'),
    uploads: gauge('velance_upload_reserved_bytes', 'Bytes reserved by in-flight telemetry uploads.'),
    rss: gauge('velance_process_resident_memory_bytes', 'Resident set size of the API process.'),
    heap: gauge('velance_process_heap_used_bytes', 'V8 heap in use on the API thread.'),
    loopP99: gauge('velance_event_loop_delay_p99_seconds', 'Event-loop delay p99 since the previous scrape.'),
    loopMax: gauge('velance_event_loop_delay_max_seconds', 'Event-loop delay maximum since the previous scrape.'),
    dbBytes: gauge('velance_db_file_bytes', 'SQLite database and WAL file sizes.'),
    diskFree: gauge('velance_disk_free_bytes', 'Free bytes on the database volume.'),
    diskSize: gauge('velance_disk_size_bytes', 'Size of the database volume.'),
    backupLast: gauge('velance_backup_last_success_timestamp_seconds', 'Snapshot time of the newest verified backup.'),
    backupAge: gauge('velance_backup_age_seconds', 'Age of the newest verified backup.'),
    alert: gauge('velance_alert', 'Built-in alert conditions; 1 means firing.')
  };
  const database = await createDatabase(dbPath, (op, ms, code) => { m.dbOps.inc({ op, result: code || 'ok' }); m.dbDuration.observe({ op }, ms / 1000); },
    (role, reason) => log('error', 'db_worker_failed', { role, reason }));
  let scheduler = null;
  try {
    if (backupDir) scheduler = startBackupScheduler({ dbPath, dir: backupDir, intervalMs: backupIntervalMs, keep: backupKeep, log, onResult: error => m.backups.inc({ result: error ? 'failed' : 'ok' }) });
  } catch (error) { await database.close(); throw error; }
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const summaries = new Map();
  let draining = false, forced = false, uploadBytes = 0, tokens = 100, tokenTime = performance.now(), logTokens = 50, logTime = performance.now(), closing;
  function admit(size) {
    if (draining || !database.healthy) fail(503, 'DB_UNAVAILABLE');
    const now = performance.now(); tokens = Math.min(100, tokens + (now - tokenTime) * .05); tokenTime = now;
    if (tokens < 1) fail(429, 'RATE_LIMIT');
    if (uploadBytes + size > UPLOAD_CAP) fail(429, 'UPLOAD_CAPACITY');
    tokens--; uploadBytes += size;
  }
  function requestLog(level, fields) {
    const now = performance.now(); logTokens = Math.min(50, logTokens + (now - logTime) * .02); logTime = now;
    if (logTokens < 1) { m.logsDropped.inc(); return; }
    logTokens--; log(level, 'request', fields);
  }
  function collect() {
    m.ready.set({}, !draining && database.healthy ? 1 : 0);
    m.draining.set({}, draining ? 1 : 0);
    let saturated = uploadBytes >= .8 * UPLOAD_CAP;
    for (const [role, connection] of [['writer', database.writer], ['reader', database.reader]]) {
      const stats = connection.stats;
      m.workerUp.set({ role }, connection.healthy ? 1 : 0);
      m.queueJobs.set({ role }, stats.jobs); m.queueBytes.set({ role }, stats.bytes);
      m.queueJobLimit.set({ role }, stats.limit); m.queueByteLimit.set({ role }, stats.byteLimit);
      saturated ||= stats.jobs >= .8 * stats.limit || stats.bytes >= .8 * stats.byteLimit;
    }
    m.uploads.set({}, uploadBytes);
    const memory = process.memoryUsage();
    m.rss.set({}, memory.rss); m.heap.set({}, memory.heapUsed);
    m.loopP99.set({}, loop.percentile(99) / 1e9); m.loopMax.set({}, loop.max / 1e9); loop.reset();
    for (const [file, path] of [['db', dbPath], ['wal', `${dbPath}-wal`]]) { let size = 0; try { size = statSync(path).size; } catch {} m.dbBytes.set({ file }, size); }
    let used = null;
    try { const fs = statfsSync(dirname(dbPath)), size = fs.blocks * fs.bsize, free = fs.bavail * fs.bsize; m.diskFree.set({}, free); m.diskSize.set({}, size); used = size ? 1 - free / size : null; } catch {}
    const age = scheduler?.age();
    if (scheduler) { m.backupLast.set({}, scheduler.state.lastSuccess == null ? 0 : scheduler.state.lastSuccess / 1000); m.backupAge.set({}, age == null ? Infinity : age / 1000); }
    const alerts = { queue_saturation: saturated, backup_stale: !!scheduler && (age == null || age > 2 * 3600000), disk_pressure: used != null && used > .8, worker_down: !draining && !database.healthy };
    for (const [alert, firing] of Object.entries(alerts)) m.alert.set({ alert }, firing ? 1 : 0);
    return metrics.render();
  }
  async function summary(params) {
    const fromRaw = params.get('from'), toRaw = params.get('to'), hoursRaw = params.get('hours');
    const explicit = fromRaw !== null || toRaw !== null;
    let from, to, key;
    if (explicit) {
      if (hoursRaw !== null || !/^\d+$/.test(fromRaw || '') || !/^\d+$/.test(toRaw || '')) fail(400, 'BAD_WINDOW');
      from = Number(fromRaw); to = Number(toRaw);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from || to - from > 31 * 86400000) fail(400, 'BAD_WINDOW');
      key = `${from}:${to}`;
    } else {
      const hours = hoursRaw ?? '24';
      if (!['1', '6', '24'].includes(hours)) fail(400, 'BAD_WINDOW');
      key = hours; to = Date.now(); from = to - Number(hours) * 3600000;
    }
    const cached = summaries.get(key);
    if (cached && (cached.pending || Date.now() - cached.at < 15000)) { m.summaryCache.inc({ result: cached.pending ? 'coalesced' : 'hit' }); return cached.promise; }
    m.summaryCache.inc({ result: 'miss' });
    if (cached) summaries.delete(key);
    if (summaries.size >= 8) {
      const oldest = [...summaries].find(([, v]) => !v.pending);
      if (!oldest) fail(429, 'READ_CAPACITY');
      summaries.delete(oldest[0]);
    }
    const entry = { pending: true, at: 0 };
    entry.promise = database.reader.call('summary', { from, to }).then(result => { entry.pending = false; entry.at = Date.now(); return result; }, error => { summaries.delete(key); throw error; });
    summaries.set(key, entry);
    return entry.promise;
  }
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000, maxHeaderSize: 16384 }, async (req, res) => {
    const started = performance.now(), requestId = randomUUID();
    let route = 'invalid', errorCode = null;
    res.setHeader('X-Request-Id', requestId);
    applySecurityHeaders(res);
    res.once('close', () => {
      const ms = performance.now() - started, method = ['GET', 'HEAD', 'POST'].includes(req.method) ? req.method : 'OTHER';
      const status = res.writableFinished ? String(res.statusCode) : 'aborted';
      m.requests.inc({ route, method, status });
      m.duration.observe({ route, method }, ms / 1000);
      if (errorCode) m.rejections.inc({ code: errorCode, class: rejectionClass(res.statusCode) });
      if (status === 'aborted' || res.statusCode >= 400 || ms >= 300) requestLog(status === 'aborted' || res.statusCode >= 500 ? 'error' : ms >= 300 ? 'warn' : 'info', { requestId, route, method, status, code: errorCode, ms: Math.round(ms) });
    });
    try {
      const host = req.headers.host;
      const match = typeof host === 'string' && /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]+))?$/i.exec(host);
      if (!match || Number(match[2] || 80) !== server.address()?.port) fail(400, 'BAD_HOST');
      const origin = `http://${host.toLowerCase()}`;
      if ((req.headers.origin != null && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'CROSS_ORIGIN');
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) fail(400, 'BAD_TARGET');
      let path;
      try { path = decodeURIComponent(req.url.split('?')[0]); } catch { fail(400, 'BAD_PATH'); }
      if (/[\\\0\r\n#?]/.test(path) || path.split('/').some(p => p === '.' || p === '..')) fail(400, 'BAD_PATH');
      route = routeOf(path);
      const url = new URL(req.url, origin);
      const method = expected => { if (req.method !== expected) { res.setHeader('Allow', expected); fail(405, 'METHOD_NOT_ALLOWED'); } };
      if (path === '/api/telemetry') {
        method('POST');
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) fail(415, 'UNSUPPORTED_MEDIA');
        const declared = req.headers['content-length'];
        if (declared !== undefined && !/^\d{1,15}$/.test(declared)) fail(400, 'BAD_LENGTH');
        if (Number(declared) > CAP) fail(413, 'PAYLOAD_TOO_LARGE');
        const reserved = declared === undefined ? CAP : Number(declared);
        admit(reserved);
        try {
          const body = await readBody(req);
          let batch;
          try { batch = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { fail(400, 'BAD_JSON'); }
          const result = await database.writer.call('ingest', validate(batch), body.length);
          m.ingest.inc({ result: result.duplicate ? 'duplicate' : 'committed' });
          json(res, 200, { ok: true });
        } finally { uploadBytes -= reserved; }
      } else if (path === '/health/live' || path === '/health/ready') {
        method('GET'); const ready = !draining && database.healthy;
        json(res, path.endsWith('/ready') && !ready ? 503 : 200, { status: path.endsWith('/live') ? 'live' : ready ? 'ready' : 'unavailable' });
      } else if (path === '/metrics') {
        method('GET'); const body = collect();
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
        res.end(body);
      } else if (path === '/api/summary') { method('GET'); if (draining || !database.healthy) fail(503, 'DB_UNAVAILABLE'); json(res, 200, await summary(url.searchParams)); }
      else if (path === '/api/sessions') {
        method('GET');
        const raw = url.searchParams.get('limit');
        if (raw !== null && !/^\d+$/.test(raw)) fail(400, 'BAD_LIMIT');
        const limit = raw === null ? 50 : Number(raw);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail(400, 'BAD_LIMIT');
        const page = await database.reader.call('sessions', { limit, cursor: url.searchParams.get('cursor') });
        json(res, 200, page.rows, page.next ? { 'X-Next-Cursor': page.next } : {});
      } else if (path.startsWith('/api/sessions/')) {
        method('GET'); const id = path.slice('/api/sessions/'.length);
        if (!ID_RE.test(id)) fail(404, 'NOT_FOUND');
        json(res, 200, await database.reader.call('detail', { id, sampleCursor: url.searchParams.get('samples'), eventCursor: url.searchParams.get('events') }));
      } else if (path.startsWith('/api/')) fail(404, 'NOT_FOUND');
      else {
        await serveStaticDelivery(req, res, { root, dbPath, path, search: url.search, policy: 'mutable', opsHeader: true });
      }
    } catch (error) {
      const status = error.status || 500, code = error.code && error.status ? error.code : 'INTERNAL';
      errorCode = code;
      if (code === 'INTERNAL') log('error', 'request_failed', { requestId, route, reason: error.name });
      if (!res.headersSent) json(res, status, { error: code, code }, { Connection: 'close', ...(status === 429 || status === 503 ? { 'Retry-After': '1' } : {}) });
      else res.destroy();
      req.resume();
    }
  });
  server.maxConnections = 512;
  server.maxRequestsPerSocket = 1000;
  const close = server.close.bind(server);
  server.shutdown = () => {
    if (closing) return closing;
    draining = true;
    log('info', 'shutdown_start', {});
    const deadline = setTimeout(() => { forced = true; server.closeAllConnections(); void database.terminate(); }, 10000);
    closing = Promise.all([new Promise(resolve => close(() => resolve())), scheduler?.stop()])
      .then(() => database.close())
      .finally(() => { clearTimeout(deadline); summaries.clear(); loop.disable(); log(forced ? 'warn' : 'info', forced ? 'shutdown_forced' : 'shutdown_complete', {}); });
    return closing;
  };
  server.close = callback => { void server.shutdown().then(() => callback?.(), error => callback?.(error)); return server; };
  server.backupPath = database.backupPath;
  server.runtime = { database, metrics, scheduler, collect, get uploadBytes() { return uploadBytes; }, get ready() { return !draining && database.healthy; }, get forced() { return forced; } };
  return server;
}

if (import.meta.main) {
  const log = createLogger();
  try {
    const usage = 'Usage: node tools/ops/server.mjs [--port 8090] [--host 127.0.0.1] [--db path] [--backup-dir dir] [--backup-keep 168]';
    const args = process.argv.slice(2), config = { port: '8090', host: '127.0.0.1', db: resolve(ROOT, 'tools/ops/telemetry.db'), 'backup-dir': '', 'backup-keep': '168' };
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].slice(2);
      if (!args[i].startsWith('--') || !Object.hasOwn(config, key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(usage);
      config[key] = args[i + 1];
    }
    if (!/^\d+$/.test(config.port) || Number(config.port) > 65535 || !HOSTS.has(config.host)) throw new Error('Port must be 0–65535 and host must be loopback');
    if (!/^\d{1,6}$/.test(config['backup-keep']) || Number(config['backup-keep']) < 1) throw new Error('--backup-keep must be a positive integer');
    const server = await createOpsServer({ dbPath: resolve(ROOT, config.db), log, backupDir: config['backup-dir'] ? resolve(ROOT, config['backup-dir']) : null, backupKeep: Number(config['backup-keep']) });
    server.on('error', () => { log('error', 'listen_failed', {}); process.exitCode = 1; void server.shutdown(); });
    server.listen(Number(config.port), config.host, () => log('info', 'listening', { url: `http://${config.host === '::1' ? '[::1]' : config.host}:${server.address().port}`, route: '/ops/' }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { log('info', 'signal', { signal }); void server.shutdown().then(() => { if (server.runtime.forced) process.exitCode = 1; }); });
  } catch (error) {
    log('error', 'startup_failed', { code: error.code || 'USAGE' });
    if (!error.code) process.stderr.write(`[ops] ${error.message}\n`);
    process.exitCode = 1;
  }
}
