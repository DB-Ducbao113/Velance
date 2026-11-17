import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { request, Agent } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const ROOT = resolve(import.meta.dirname, '../..');
const DAY = 86_400_000;
const SESSIONS_PER_DAY = 1000;
const SAMPLES_PER_SEED = 300;
const MAX_PENDING = 128;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_LOG_LINES = 20;
const WAIT = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));
const TABLES = ['sessions', 'samples', 'events', 'batches'];

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}
export function distribution(values) {
  if (!values.length) return { n: 0, min: null, mean: null, p50: null, p95: null, p99: null, max: null };
  const n = values.length;
  let sum = 0, min = Infinity, max = -Infinity;
  for (const value of values) { sum += value; if (value < min) min = value; if (value > max) max = value; }
  const sorted = values.toSorted((a, b) => a - b);
  const at = q => sorted[Math.max(0, Math.ceil(q * n) - 1)];
  return { n, min, mean: sum / n, p50: at(.5), p95: at(.95), p99: at(.99), max };
}
function usage() {
  return 'Usage: node tools/perf/backend_load.mjs [--duration 10] [--rate 10] [--days 0] [--out report.json] [--seed-only] [--smoke] [--probe-large-window] [--strict]';
}
export function parseOptions(args) {
  const options = { duration: 10, rate: 10, days: 0, out: null, seedOnly: false,
    smoke: false, strict: false, probeLargeWindow: false };
  const named = new Set(['--duration', '--rate', '--days', '--out']);
  const flags = { '--seed-only': 'seedOnly', '--smoke': 'smoke', '--probe-large-window': 'probeLargeWindow', '--strict': 'strict' };
  const used = new Set();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (used.has(name) || (!named.has(name) && !flags[name])) throw new Error(usage());
    used.add(name);
    if (flags[name]) { options[flags[name]] = true; continue; }
    const value = args[++i];
    if (value == null || value.startsWith('--')) throw new Error(usage());
    if (name === '--out') options.out = resolve(value);
    else options[name.slice(2)] = Number(value);
  }
  if (options.smoke) {
    if (['--duration', '--rate', '--days'].some(k => used.has(k))) throw new Error('--smoke cannot override explicit duration, rate or days');
    options.duration = 3; options.rate = 5; options.days = 0;
  }
  if (!Number.isInteger(options.duration) || options.duration < 1 || options.duration > 3600
    || !Number.isFinite(options.rate) || options.rate < 1 || options.rate > 200
    || !Number.isInteger(options.days) || options.days < 0 || options.days > 30) throw new Error(usage());
  if (options.out && existsSync(options.out)) throw new Error('--out already exists (refusing to overwrite)');
  return options;
}

function completeJSON(port, path, { body = null, agent, scheduledAt = performance.now() } = {}) {
  const startedAt = performance.now();
  return new Promise(resolveResult => {
    let finished = false, req, timer;
    const finish = record => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const finishedAt = performance.now();
      resolveResult({ path, status: record.status ?? 0, kind: record.kind, code: record.code ?? null,
        bytes: record.bytes ?? 0, offeredMs: finishedAt - scheduledAt, networkMs: finishedAt - startedAt });
    };
    req = request({ host: '127.0.0.1', port, path, method: body == null ? 'GET' : 'POST', agent,
      headers: body == null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', part => {
        bytes += part.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          finish({ kind: 'invalid_response', status: response.statusCode, code: 'BODY_TOO_LARGE' });
          req.destroy();
        } else chunks.push(part);
      });
      response.on('error', () => finish({ kind: 'incomplete_response', status: response.statusCode }));
      response.on('aborted', () => finish({ kind: 'incomplete_response', status: response.statusCode }));
      response.on('end', () => {
        if (!response.complete) return finish({ kind: 'incomplete_response', status: response.statusCode });
        if (!/^application\/json(?:;|$)/i.test(response.headers['content-type'] || '')) {
          return finish({ kind: 'invalid_response', status: response.statusCode, code: 'BAD_CONTENT_TYPE' });
        }
        const declared = response.headers['content-length'];
        if (declared != null && Number(declared) !== bytes) {
          return finish({ kind: 'incomplete_response', status: response.statusCode, code: 'BAD_CONTENT_LENGTH' });
        }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return finish({ kind: 'invalid_response', status: response.statusCode, code: 'BAD_JSON' }); }
        const expectedArray = path.startsWith('/api/sessions?');
        if (!data || typeof data !== 'object' || (Array.isArray(data) !== expectedArray)) {
          return finish({ kind: 'invalid_response', status: response.statusCode, code: 'BAD_SHAPE' });
        }
        if (response.statusCode === 200 && body != null && data.ok !== true) {
          return finish({ kind: 'invalid_response', status: 200, code: 'MISSING_ACK' });
        }
        if (response.statusCode !== 200 && typeof data.code !== 'string') {
          return finish({ kind: 'invalid_response', status: response.statusCode, code: 'MISSING_ERROR_CODE' });
        }
        finish({ kind: 'response', status: response.statusCode, code: data.code, bytes });
      });
    });
    req.once('error', error => finish({ kind: error.code === 'BENCHMARK_TIMEOUT' ? 'timeout' : 'network_error', code: error.code || 'NETWORK_ERROR' }));
    timer = setTimeout(() => req.destroy(Object.assign(new Error('request exceeded deadline'), { code: 'BENCHMARK_TIMEOUT' })), REQUEST_TIMEOUT_MS);
    req.end(body ?? undefined);
  });
}

async function startChild(dbPath, resourceSamples, errors) {
  const child = fork(import.meta.filename, ['--child', '--db', dbPath], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  const appendError = text => { if (errors.length < MAX_LOG_LINES) errors.push(String(text).slice(0, 300)); };
  child.stderr.on('data', data => appendError(data.toString('utf8')));
  let listening = false;
  const port = await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error('fixture server startup timed out')), 20_000);
    const fail = error => { if (listening) return; clearTimeout(timer); no(error); };
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`fixture server exited before ready: ${code}`)));
    child.on('message', message => {
      if (message.type === 'resources') {
        if (resourceSamples.length < 5000) resourceSamples.push(message);
      } else if (message.type === 'ready' && !listening) {
        listening = true; clearTimeout(timer); yes(message.port);
      }
    });
  }).catch(error => { child.kill('SIGKILL'); throw error; });
  let stopped = false;
  return { port, async stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null || child.signalCode != null) return;
    const exiting = once(child, 'exit');
    try { child.send('stop'); } catch { child.kill('SIGKILL'); }
    const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try { await exiting; } finally { clearTimeout(deadline); }
  }, kill() { child.kill('SIGKILL'); } };
}

async function childMain(argv) {
  const dbArg = argv.indexOf('--db');
  if (dbArg < 0 || !argv[dbArg + 1]) throw new Error('child requires fixture --db');
  const path = resolve(argv[dbArg + 1]);
  const parent = realpathSync(dirname(path));
  if (basename(path) !== 'fixture.db' || dirname(parent) !== realpathSync(tmpdir())
    || !basename(parent).startsWith('velance-p4-load-')) {
    throw new Error('child database must be an isolated temporary fixture');
  }
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || realpathSync(path) !== join(parent, 'fixture.db'))) {
    throw new Error('fixture database must not be a symlink');
  }
  const { createOpsServer } = await import('../ops/server.mjs');
  const server = await createOpsServer({ root: ROOT, dbPath: path });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  const resources = () => {
    process.send?.({ type: 'resources', rss: process.memoryUsage().rss,
      loopP99Ms: delay.percentile(99) / 1e6 });
    delay.reset();
  };
  resources();
  const timer = setInterval(resources, 1000); timer.unref();
  process.send?.({ type: 'ready', port: server.address().port });
  process.once('message', async message => {
    if (message !== 'stop') return;
    clearInterval(timer); resources(); delay.disable();
    try { await server.shutdown(); process.disconnect(); }
    catch (error) { console.error(error?.code || 'SHUTDOWN_FAILED'); process.exitCode = 1; process.disconnect(); }
  });
}

function seedFixture(dbPath, days, progress) {
  const db = new DatabaseSync(dbPath);
  const sessions = days * SESSIONS_PER_DAY;
  const anchor = Date.now() - 1000;
  const started = performance.now();
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    const insertSession = db.prepare(`INSERT INTO sessions(id,started_at,received_at,context,milestones,backend,mobile,final,last_seq)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    const insertSamples = db.prepare(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i + 1 FROM n WHERE i < 299)
      INSERT INTO samples SELECT ?, i * 1000, 'browse', 60, 1, 2, 724, 1965726, 16, 160, 1 FROM n`);
    const insertBatches = db.prepare(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i + 1 FROM n WHERE i < 29)
      INSERT INTO batches SELECT ?, i FROM n`);
    const insertEvent = db.prepare('INSERT INTO events VALUES(?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < sessions; i++) {
      const id = `seed-${String(i).padStart(8, '0')}`;
      const age = Math.floor(i / SESSIONS_PER_DAY) * DAY + i % SESSIONS_PER_DAY * (DAY / SESSIONS_PER_DAY);
      const at = anchor - age;
      insertSession.run(id, at, at, null, '{"firstCar":1800,"allLoaded":3000}', 'webgpu', 0, null, 29);
      insertSamples.run(id); insertBatches.run(id);
      insertEvent.run(id, 10000, 'overviewBtn', null);
      insertEvent.run(id, 20000, 'paint', '{"i":3}');
      if ((i + 1) % 500 === 0) {
        db.exec('COMMIT');
        progress?.(i + 1, sessions);
        if (i + 1 < sessions) db.exec('BEGIN IMMEDIATE');
      }
    }
    if (sessions % 500 !== 0 || sessions === 0) db.exec('COMMIT');
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(checkpoint.busy, 0, 'seed WAL checkpoint was busy');
    return { sessions, samples: sessions * SAMPLES_PER_SEED, events: sessions * 2,
      batches: sessions * 30, anchor, ms: performance.now() - started, checkpoint };
  } finally { db.close(); }
}

function telemetryBatch(index, startedAt) {
  return JSON.stringify({ id: `live-${String(index).padStart(10, '0')}`, seq: 0, startedAt,
    backend: 'webgpu', context: { mobile: false },
    milestones: { enter: 500, firstCar: 1800, allLoaded: 3000 },
    final: { duration: 10_000, stats: { loaded: 16, loadTimes: { senna: 125 } } },
    samples: Array.from({ length: 10 }, (_, sample) => ({ t: sample * 1000, phase: 'browse', fps: 60,
      renderAvg: 1, renderP95: 2, loaded: 16, drawCalls: 724, triangles: 1965726 })),
    events: [{ t: 1000, type: 'paint', data: { i: 1 } }] });
}

function verifyFixture(dbPath, seed, acknowledgedIds) {
  const db = new DatabaseSync(dbPath);
  try {
    const beforeWalBytes = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const counts = Object.fromEntries(TABLES.map(table => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
    const seedPersisted = db.prepare("SELECT count(*) n FROM sessions WHERE id LIKE 'seed-%'").get().n;
    const liveRows = db.prepare("SELECT id FROM sessions WHERE id LIKE 'live-%' ORDER BY id").all().map(x => x.id);
    const liveBatchRows = db.prepare("SELECT session_id FROM batches WHERE session_id LIKE 'live-%' AND seq=0 ORDER BY session_id").all().map(x => x.session_id);
    const idSet = new Set(acknowledgedIds), persisted = new Set(liveRows), receipts = new Set(liveBatchRows);
    const missingAck = acknowledgedIds.filter(id => !persisted.has(id) || !receipts.has(id));
    const unacknowledgedRows = liveRows.filter(id => !idSet.has(id));
    const incompleteLive = db.prepare(`SELECT count(*) n FROM sessions s WHERE id LIKE 'live-%'
      AND ((SELECT count(*) FROM samples WHERE session_id=s.id) != 10
      OR (SELECT count(*) FROM events WHERE session_id=s.id) != 1
      OR (SELECT count(*) FROM batches WHERE session_id=s.id) != 1)`).get().n;
    const orphans = Object.fromEntries(['samples', 'events', 'batches'].map(table => [table,
      db.prepare(`SELECT count(*) n FROM ${table} WHERE session_id NOT IN (SELECT id FROM sessions)`).get().n]));
    const expected = { sessions: seed.sessions + acknowledgedIds.length,
      samples: seed.samples + acknowledgedIds.length * 10,
      events: seed.events + acknowledgedIds.length,
      batches: seed.batches + acknowledgedIds.length };
    const ok = integrity === 'ok' && mode === 'wal' && checkpoint.busy === 0
      && seedPersisted === seed.sessions && missingAck.length === 0 && unacknowledgedRows.length === 0
      && liveRows.length === acknowledgedIds.length && liveBatchRows.length === acknowledgedIds.length
      && incompleteLive === 0 && Object.values(orphans).every(n => n === 0)
      && TABLES.every(table => expected[table] === counts[table]);
    return { ok, integrity, journalMode: mode, wal: { beforeCheckpointBytes: beforeWalBytes, checkpoint },
      counts, expected, seedPersisted, livePersisted: liveRows.length, receiptsPersisted: liveBatchRows.length,
      missingAck: { count: missingAck.length, examples: missingAck.slice(0, 10) },
      unacknowledgedRows: { count: unacknowledgedRows.length, examples: unacknowledgedRows.slice(0, 10) },
      incompleteLive, orphans };
  } finally { db.close(); }
}

function breakdown(results) {
  const statuses = {}, codes = {}, kinds = {};
  for (const result of results) {
    const status = String(result.status);
    statuses[status] = (statuses[status] || 0) + 1;
    kinds[result.kind] = (kinds[result.kind] || 0) + 1;
    if (result.code) codes[result.code] = (codes[result.code] || 0) + 1;
  }
  return { statuses, codes, kinds };
}

async function benchmark(options) {
  const temp = mkdtempSync(join(tmpdir(), 'velance-p4-load-'));
  const dbPath = join(temp, 'fixture.db');
  const errors = [], resources = [], requests = [], reads = [];
  const agent = new Agent({ keepAlive: true, maxSockets: MAX_PENDING });
  let child;
  try {
    // Start once to create the schema, then close every worker before seeding.
    child = await startChild(dbPath, resources, errors);
    await child.stop(); child = null;
    const seed = seedFixture(dbPath, options.days, (done, total) => {
      if (total >= 5000 && done % 5000 === 0) process.stderr.write(`seeded ${done}/${total} fixture sessions\n`);
    });
    const seedBytes = statSync(dbPath).size;
    if (options.seedOnly) {
      const verification = verifyFixture(dbPath, seed, []);
      return { measuredAt: new Date().toISOString(), mode: 'seed-only',
        profile: { days: options.days, seedSessions: seed.sessions, seedSamples: seed.samples, seedMs: seed.ms, seedBytes },
        verification, gates: { integrity: verification.ok } };
    }
    resources.length = 0;
    child = await startChild(dbPath, resources, errors);
    const pending = new Set(), successIds = [];
    const started = performance.now(), wallAt = Date.now();
    const endAt = started + options.duration * 1000;
    const offered = Math.floor(options.duration * options.rate);
    let startedRequests = 0, dropped = 0, peakPending = 0, bytesOffered = 0;
    const schedulingLags = [], actualStartsBySecond = new Map();
    const sendDashboard = async (route, scheduledAt) => {
      const r = await completeJSON(child.port, route, { agent, scheduledAt });
      reads.push(r);
    };
    const dashboard = async index => {
      let next = started;
      while (next < endAt) {
        if (next > performance.now()) await WAIT(next - performance.now());
        const scheduledAt = next;
        await Promise.all([
          sendDashboard('/api/summary?hours=24', scheduledAt),
          sendDashboard('/api/sessions?limit=50', scheduledAt)
        ]);
        next += 5000;
      }
    };
    const readThreads = [dashboard(0), dashboard(1)];
    for (let i = 0; i < offered; i++) {
      const scheduledAt = started + i * 1000 / options.rate;
      if (scheduledAt > performance.now()) await WAIT(scheduledAt - performance.now());
      const lag = performance.now() - scheduledAt;
      schedulingLags.push(lag);
      if (pending.size >= MAX_PENDING) { dropped++; continue; }
      const batch = telemetryBatch(i, Math.floor(wallAt + i * 1000 / options.rate));
      const id = `live-${String(i).padStart(10, '0')}`;
      startedRequests++; bytesOffered += Buffer.byteLength(batch);
      const actualSecond = Math.floor((performance.now() - started) / 1000);
      actualStartsBySecond.set(actualSecond, (actualStartsBySecond.get(actualSecond) || 0) + 1);
      const pendingJob = completeJSON(child.port, '/api/telemetry', { body: batch, agent, scheduledAt })
        .then(result => {
          requests.push(result);
          if (result.kind === 'response' && result.status === 200) successIds.push(id);
        }).finally(() => pending.delete(pendingJob));
      pending.add(pendingJob);
      peakPending = Math.max(peakPending, pending.size);
    }
    await Promise.all(pending);
    await Promise.all(readThreads);
    let largeWindowProbe = null;
    if (options.probeLargeWindow) {
      const from = Math.max(0, seed.anchor - options.days * DAY);
      const to = Date.now() + 1000;
      const reply = await completeJSON(child.port, `/api/summary?from=${from}&to=${to}`, { agent });
      const largeEnough = seed.samples + successIds.length * 10 > 1_000_000;
      largeWindowProbe = { status: reply.status, kind: reply.kind, code: reply.code, ms: reply.networkMs,
        expected: largeEnough ? 422 : 200,
        valid: reply.kind === 'response' && reply.status === (largeEnough ? 422 : 200)
          && (!largeEnough || reply.code === 'WINDOW_TOO_LARGE') };
    }
    await child.stop(); child = null;
    const verification = verifyFixture(dbPath, seed, successIds);
    const accepted = requests.filter(r => r.kind === 'response' && r.status === 200);
    const observed = requests.filter(r => r.kind === 'response');
    const admitted = accepted;
    const non429Responses = observed.filter(r => r.status !== 429);
    const expected429 = requests.filter(r => r.kind === 'response' && r.status === 429
      && ['RATE_LIMIT', 'DB_QUEUE_FULL', 'UPLOAD_CAPACITY'].includes(r.code));
    const other429 = requests.filter(r => r.kind === 'response' && r.status === 429
      && !['RATE_LIMIT', 'DB_QUEUE_FULL', 'UPLOAD_CAPACITY'].includes(r.code));
    const timeout = requests.filter(r => r.kind === 'timeout').length;
    const networkErrors = requests.filter(r => r.kind === 'network_error').length;
    const invalidResponses = requests.filter(r => ['invalid_response', 'incomplete_response'].includes(r.kind)).length;
    const failedHTTP = requests.filter(r => r.kind === 'response' && r.status !== 200 && r.status !== 429).length;
    const successRate = offered ? accepted.length / offered : 0;
    const overload = options.rate >= 50;
    const latency = {
      offeredCompleted: distribution(requests.map(r => r.offeredMs)),
      admitted: distribution(admitted.map(r => r.networkMs)),
      non429Responses: distribution(non429Responses.map(r => r.networkMs)),
      successful: distribution(accepted.map(r => r.networkMs)),
      arrivalToAck: distribution(accepted.map(r => r.offeredMs)),
      rejection429: distribution(expected429.map(r => r.networkMs)),
      schedulingLag: distribution(schedulingLags)
    };
    const byRoute = Object.fromEntries([...new Set(reads.map(r => r.path))].map(route => {
      const relevant = reads.filter(r => r.path === route);
      return [route, { ...breakdown(relevant), latency: distribution(relevant.map(r => r.networkMs)) }];
    }));
    const readOk = reads.length > 0 && reads.every(r => r.kind === 'response' && r.status === 200);
    const readP95 = percentile(reads.filter(r => r.kind === 'response').map(r => r.networkMs), .95);
    const peakRss = resources.length ? Math.max(...resources.map(r => r.rss)) : null;
    const maxLoopP99 = resources.length ? Math.max(...resources.map(r => r.loopP99Ms)) : null;
    const gates = {
      mode: overload ? 'overload' : 'normal',
      validOfferedSuccess99_9pct: overload ? null : successRate >= .999,
      ingestP95Under150ms: overload ? null : latency.arrivalToAck.p95 != null && latency.arrivalToAck.p95 < 150,
      ingestP99Under300ms: overload ? null : latency.arrivalToAck.p99 != null && latency.arrivalToAck.p99 < 300,
      dashboardP95Under500ms: readOk && readP95 != null && readP95 < 500,
      rssWithin512MiB: peakRss != null && peakRss <= 512 * 1048576,
      eventLoopP99Within50ms: maxLoopP99 != null && maxLoopP99 <= 50,
      durabilityAndIntegrity: verification.ok,
      optionalLargeWindowProbe: largeWindowProbe ? largeWindowProbe.valid : null
    };
    gates.overall = overload ? null : Object.entries(gates).filter(([key, value]) => key !== 'mode' && value !== null).every(([, value]) => value === true);
    return {
      measuredAt: new Date().toISOString(), environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
      mode: overload ? 'overload' : 'normal',
      profile: { durationSeconds: options.duration, offeredRatePerSecond: options.rate,
        days: options.days, seedSessions: seed.sessions, seedSamples: seed.samples,
        seedMs: seed.ms, seedBytes, dashboardClients: 2,
        arrival: 'open-loop monotonic absolute scheduling; no retry; latency measured from scheduled arrival',
        maxPending: MAX_PENDING, timeoutMs: REQUEST_TIMEOUT_MS },
      ingest: { offered, started: startedRequests, localDropped: dropped, peakPending, bytesOffered,
        actualStartedRatePerSecond: startedRequests / options.duration,
        actualStartsPerSecond: { bins: [...actualStartsBySecond].sort((a,b) => a[0] - b[0]),
          distribution: distribution([...actualStartsBySecond.values()]) },
        completed: requests.length, acknowledged200: accepted.length,
        successRateOfValidOffered: successRate, admittedKnown: admitted.length,
        expected429: expected429.length, unexpected429: other429.length,
        timeout, networkErrors, invalidResponses, otherHTTP: failedHTTP,
        ...breakdown(requests) },
      latencyMs: latency,
      dashboard: { count: reads.length, complete200: reads.filter(r => r.kind === 'response' && r.status === 200).length,
        p95Ms: readP95, ...breakdown(reads), byRoute, expected422ProbedSeparately: largeWindowProbe },
      resources: { samples: resources.length, peakRssBytes: peakRss, maxEventLoopP99Ms: maxLoopP99,
        rssBytes: distribution(resources.map(r => r.rss)), eventLoopP99Ms: distribution(resources.map(r => r.loopP99Ms)) },
      verification, errors: errors.slice(0, MAX_LOG_LINES), gates,
      interpretation: overload
        ? 'Overload profile: 429 rejections are reported separately; full-offered success is NOT claimed or gated.'
        : 'Normal profile: success denominator includes ALL valid offered requests, including local drops and 429.'
    };
  } finally {
    agent.destroy();
    if (child) await child.stop().catch(() => child.kill());
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes('--child')) {
  await childMain(process.argv.slice(2));
} else if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await benchmark(options);
    if (options.out) writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const { profile, ingest, dashboard, resources, verification, gates } = result;
    console.log(JSON.stringify({ mode: result.mode, profile, ingest, dashboard: { count: dashboard?.count, p95Ms: dashboard?.p95Ms },
      resources: { peakRssBytes: resources?.peakRssBytes, maxEventLoopP99Ms: resources?.maxEventLoopP99Ms },
      verification: { ok: verification.ok, counts: verification.counts }, gates, out: options.out }, null, 2));
    if (!verification.ok || (options.strict && gates.overall === false)) process.exitCode = 1;
  } catch (error) {
    console.error(error?.message || 'load harness failed');
    process.exitCode = 1;
  }
}
