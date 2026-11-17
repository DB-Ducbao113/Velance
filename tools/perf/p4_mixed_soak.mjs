// P4 mixed-soak fixture. Intentionally never accepts a caller-supplied DB path.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { Agent, request } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, arch, cpus, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { openStore } from '../ops/store.mjs';
import { runOperation } from '../ops/operations.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const DAY = 86_400_000;
const SEED_PER_DAY = 1000;
const SEED_SAMPLES = 300;
const MAX_POST_PENDING = 64;
const MAX_READ_PENDING = 32;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR = 2048;
const REQUEST_TIMEOUT_MS = 8000;
const NATIVE_NODE = Number(process.versions.node.split('.')[0]);
const wait = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const array = values.toSorted((a, b) => a - b);
  return array[Math.max(0, Math.ceil(array.length * fraction) - 1)];
}
export function stats(values) {
  if (!values.length) return { n: 0, p50: null, p95: null, p99: null, max: null, mean: null };
  const sorted = values.toSorted((a, b) => a - b);
  const at = q => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  return { n: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1),
    mean: values.reduce((sum, n) => sum + n, 0) / values.length };
}
export function parseOptions(args) {
  const result = { duration: 60, rate: 10, days: 3, out: null, smoke: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw new Error(`Duplicate flag ${key}`);
    seen.add(key);
    if (key === '--smoke') { result.smoke = true; continue; }
    if (!['--duration', '--rate', '--days', '--out'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Usage: p4_mixed_soak.mjs [--duration 60] [--rate 10] [--days 3] [--out new-report.json] [--smoke]');
    }
    const value = args[++i];
    if (key === '--out') result.out = resolve(value);
    else result[key.slice(2)] = Number(value);
  }
  if (result.smoke) {
    if (['--duration', '--rate', '--days'].some(flag => seen.has(flag))) throw new Error('--smoke cannot override duration/rate/days');
    result.duration = 3; result.days = 0; result.rate = 10;
  }
  if (!Number.isInteger(result.duration) || result.duration < 1 || result.duration > 120
    || result.rate !== 10 || !Number.isInteger(result.days) || result.days < 0 || result.days > 3
    || result.out && existsSync(result.out)) throw new Error('Invalid options; duration 1..120, rate exactly 10, days 0..3, --out must not exist');
  return result;
}

// Repeating sequence [0,1,1,2] exercises two identical deliveries and
// out-of-order completion without making the ingest payload invalid.
export function batchFor(index, epoch, rate = 10) {
  const group = Math.floor(index / 4);
  const seq = [0, 1, 1, 2][index % 4];
  const id = `mix-${String(group).padStart(8, '0')}`;
  const startedAt = Math.floor(epoch + group * 4 * 1000 / rate);
  const payload = {
    id, seq, startedAt, backend: 'webgpu', context: { mobile: false },
    milestones: { gateShown: 0, firstCar: 100, allLoaded: 400, enter: 500 },
    final: { duration: (seq + 1) * 4000, stats: { loaded: 16 } },
    samples: [0, 1, 2].map(n => ({ t: seq * 4000 + n * 1000, phase: 'browse', fps: 60,
      renderAvg: 2, renderP95: 3, loaded: 16, drawCalls: 100, triangles: 10000 })),
    events: [{ t: seq * 4000 + 100, type: 'paint', data: { i: seq } }]
  };
  return { id, seq, key: `${id}:${seq}`, body: JSON.stringify(payload) };
}

function tally(records) {
  const statuses = {}, kinds = {}, codes = {};
  for (const r of records) {
    const s = String(r.status ?? 0);
    statuses[s] = (statuses[s] || 0) + 1;
    kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    if (r.code) codes[r.code] = (codes[r.code] || 0) + 1;
  }
  return { statuses, kinds, codes };
}

function checkedRequest(port, { path, body = null, type, agent, scheduled = performance.now() }) {
  const started = performance.now();
  return new Promise(done => {
    let settled = false, timeout, req;
    const finish = record => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      done({ path, type, ...record, latencyMs: performance.now() - scheduled,
        wireMs: performance.now() - started });
    };
    try {
      req = request({ host: '127.0.0.1', port, path, method: body === null ? 'GET' : 'POST',
        agent, headers: body === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        let bytes = 0;
        const chunks = [];
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            finish({ kind: 'invalid_response', status: res.statusCode, code: 'RESPONSE_TOO_LARGE' });
            req.destroy();
          } else chunks.push(chunk);
        });
        res.once('error', error => finish({ kind: 'incomplete_response', status: res.statusCode, code: error.code || 'RESPONSE_ERROR' }));
        res.once('aborted', () => finish({ kind: 'incomplete_response', status: res.statusCode, code: 'ABORTED' }));
        res.once('close', () => { if (!res.complete) finish({ kind: 'incomplete_response', status: res.statusCode, code: 'CLOSED' }); });
        res.once('end', () => {
          if (!res.complete || res.headers['content-length'] && Number(res.headers['content-length']) !== bytes) {
            return finish({ kind: 'incomplete_response', status: res.statusCode, code: 'BAD_LENGTH' });
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          if (type === 'metrics') {
            if (res.statusCode === 200 && !/^text\/plain/.test(res.headers['content-type'] || '') || !raw.includes('velance_')) {
              return finish({ kind: 'invalid_response', status: res.statusCode, code: 'INVALID_METRICS' });
            }
            return finish({ kind: 'response', status: res.statusCode, bytes });
          }
          if (!/^application\/json/.test(res.headers['content-type'] || '')) {
            return finish({ kind: 'invalid_response', status: res.statusCode, code: 'NOT_JSON' });
          }
          let data;
          try { data = JSON.parse(raw); }
          catch { return finish({ kind: 'invalid_response', status: res.statusCode, code: 'BAD_JSON' }); }
          const shape = res.statusCode !== 200 ? data && !Array.isArray(data) && typeof data.code === 'string'
            : type === 'telemetry' ? data && data.ok === true
            : type === 'summary' ? data && !Array.isArray(data) && Number.isInteger(data.sessions)
            : type === 'sessions' ? Array.isArray(data)
            : type === 'ready' ? data && data.status === 'ready'
            : type === 'detail' ? data && !Array.isArray(data) && Array.isArray(data.samples) && Number.isInteger(data.last_seq)
            : false;
          if (!shape) return finish({ kind: 'invalid_response', status: res.statusCode, code: 'INVALID_SHAPE' });
          finish({ kind: 'response', status: res.statusCode, code: res.statusCode === 200 ? null : data.code, bytes });
        });
      });
      req.once('error', error => finish({ kind: error.code === 'SOAK_TIMEOUT' ? 'timeout' : 'network_error',
        status: 0, code: error.code || 'REQUEST_ERROR' }));
      timeout = setTimeout(() => req.destroy(Object.assign(new Error('soak timeout'), { code: 'SOAK_TIMEOUT' })), REQUEST_TIMEOUT_MS);
      req.end(body ?? undefined);
    } catch (error) { finish({ kind: 'network_error', status: 0, code: error.code || 'REQUEST_CREATE_FAILED' }); }
  });
}

function safeFixturePath(dbPath) {
  const p = resolve(dbPath);
  const directory = realpathSync(dirname(p));
  if (basename(p) !== 'fixture.db' || dirname(directory) !== realpathSync(tmpdir())
    || !basename(directory).startsWith('velance-p4-mixed-')) throw new Error('Only isolated temporary fixture databases are permitted');
  if (existsSync(p) && (lstatSync(p).isSymbolicLink() || realpathSync(p) !== join(directory, 'fixture.db'))) {
    throw new Error('Fixture must not be a symlink');
  }
  return p;
}

async function childMain(argv) {
  const index = argv.indexOf('--db');
  if (index < 0 || !argv[index + 1]) throw new Error('Child requires fixture --db');
  const dbPath = safeFixturePath(argv[index + 1]);
  const { createOpsServer } = await import('../ops/server.mjs');
  const server = await createOpsServer({ root: ROOT, dbPath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const monitor = monitorEventLoopDelay({ resolution: 10 });
  monitor.enable();
  const sample = () => {
    process.send?.({ type: 'resource', rssBytes: process.memoryUsage().rss, loopP99Ms: monitor.percentile(99) / 1e6 });
    monitor.reset();
  };
  const timer = setInterval(sample, 1000);
  timer.unref();
  sample();
  process.send?.({ type: 'ready', port: server.address().port });
  process.once('message', async message => {
    if (message !== 'stop') return;
    clearInterval(timer);
    sample();
    monitor.disable();
    try { await server.shutdown(); process.disconnect(); }
    catch (error) { console.error(error.code || 'SHUTDOWN_FAILED'); process.exitCode = 1; process.disconnect(); }
  });
}

async function launchChild(dbPath, resources, errors) {
  const child = fork(import.meta.filename, ['--child', '--db', dbPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  child.stderr.on('data', chunk => {
    if (errors.length < 10) errors.push(chunk.toString('utf8').slice(0, MAX_STDERR));
  });
  let ready = false, stopped = false;
  const port = await new Promise((ok, no) => {
    const timeout = setTimeout(() => no(new Error('Server startup timeout')), 20_000);
    const onExit = (code, signal) => { if (!ready) { clearTimeout(timeout); no(new Error(`Server exited before ready: ${code}/${signal}`)); } };
    child.once('exit', onExit);
    child.once('error', error => { if (!ready) { clearTimeout(timeout); no(error); } });
    child.on('message', message => {
      if (message.type === 'resource' && resources.length < 1000) resources.push(message);
      if (message.type === 'ready' && !ready) {
        ready = true; clearTimeout(timeout); ok(message.port);
      }
    });
  }).catch(error => { child.kill('SIGKILL'); throw error; });
  async function stop(signal = null) {
    if (stopped) return { signal: child.signalCode, code: child.exitCode };
    stopped = true;
    if (child.exitCode !== null || child.signalCode !== null) return { signal: child.signalCode, code: child.exitCode };
    const exited = once(child, 'exit').then(([code, exitSignal]) => ({ code, signal: exitSignal }));
    if (signal) child.kill(signal);
    else child.send('stop');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try { return await exited; }
    finally { clearTimeout(timeout); }
  }
  return { port, stop, get pid() { return child.pid; } };
}

async function prepareFixture(dbPath, days) {
  const store = await openStore(dbPath);
  store.close();
  const db = new DatabaseSync(dbPath);
  const started = performance.now();
  const count = days * SEED_PER_DAY;
  const anchor = Date.now() - 5000;
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    const sessions = db.prepare(`INSERT INTO sessions(id,started_at,received_at,context,milestones,backend,mobile,final,last_seq)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    const samples = db.prepare(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<299)
      INSERT INTO samples SELECT ?, i*1000, 'browse', 60, 1, 2, 100, 10000, 16, 160, 1 FROM n`);
    const batches = db.prepare(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<29)
      INSERT INTO batches SELECT ?, i FROM n`);
    const events = db.prepare('INSERT INTO events VALUES(?,?,?,?)');
    for (let i = 0; i < count; i++) {
      const id = `seed-${String(i).padStart(8, '0')}`;
      const age = Math.floor(i / SEED_PER_DAY) * DAY + i % SEED_PER_DAY * (DAY / SEED_PER_DAY);
      const at = anchor - age;
      sessions.run(id, at, at, null, '{"firstCar":1800,"allLoaded":3000}', 'webgpu', 0, null, 29);
      samples.run(id); batches.run(id);
      events.run(id, 10000, 'paint', '{"i":1}');
      events.run(id, 20000, 'overviewBtn', null);
      if ((i + 1) % 500 === 0) { db.exec('COMMIT'); if (i + 1 < count) db.exec('BEGIN IMMEDIATE'); }
    }
    if (!count || count % 500) db.exec('COMMIT');
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(checkpoint.busy, 0, 'WAL checkpoint failed');
    return { sessions: count, samples: count * SEED_SAMPLES, events: count * 2, batches: count * 30,
      checkpoint, durationMs: performance.now() - started, bytes: statSync(dbPath).size };
  } finally { db.close(); }
}

function verifyDatabase(dbPath, seed, acked, { probeReceipts = [] } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    const counts = Object.fromEntries(['sessions', 'samples', 'events', 'batches'].map(table => [table,
      db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
    const seedCount = db.prepare("SELECT count(*) n FROM sessions WHERE id LIKE 'seed-%'").get().n;
    const liveSessions = db.prepare("SELECT id,last_seq FROM sessions WHERE id LIKE 'mix-%'").all();
    const receipts = db.prepare("SELECT session_id,seq FROM batches WHERE session_id LIKE 'mix-%'").all();
    const liveSamples = db.prepare("SELECT count(*) n FROM samples WHERE session_id LIKE 'mix-%'").get().n;
    const liveEvents = db.prepare("SELECT count(*) n FROM events WHERE session_id LIKE 'mix-%'").get().n;
    const orphanCounts = Object.fromEntries(['samples', 'events', 'batches'].map(table => [table,
      db.prepare(`SELECT count(*) n FROM ${table} WHERE session_id NOT IN (SELECT id FROM sessions)`).get().n]));
    const expectedKeys = new Set(acked.map(batch => batch.key).concat(probeReceipts.map(batch => batch.key)));
    const expectedSessions = new Map();
    for (const item of [...acked, ...probeReceipts]) expectedSessions.set(item.id, Math.max(item.seq, expectedSessions.get(item.id) ?? -1));
    const savedKeys = new Set(receipts.map(item => `${item.session_id}:${item.seq}`));
    const missingAcknowledged = [...expectedKeys].filter(key => !savedKeys.has(key));
    const unexpectedReceipts = [...savedKeys].filter(key => !expectedKeys.has(key));
    const wrongOrder = liveSessions.filter(item => item.last_seq !== expectedSessions.get(item.id)).map(item => item.id);
    const duplicateAckCount = acked.length - new Set(acked.map(item => item.key)).size;
    const expected = { sessions: seed.sessions + expectedSessions.size,
      samples: seed.samples + expectedKeys.size * 3, events: seed.events + expectedKeys.size,
      batches: seed.batches + expectedKeys.size };
    const ok = integrity === 'ok' && mode === 'wal' && checkpoint.busy === 0 && seedCount === seed.sessions
      && missingAcknowledged.length === 0 && unexpectedReceipts.length === 0 && wrongOrder.length === 0
      && liveSessions.length === expectedSessions.size && receipts.length === expectedKeys.size
      && liveSamples === expectedKeys.size * 3 && liveEvents === expectedKeys.size
      && Object.values(orphanCounts).every(n => n === 0)
      && Object.entries(expected).every(([table, n]) => counts[table] === n);
    return { ok, integrity, mode, checkpoint, counts, expected, seedCount,
      liveSessions: liveSessions.length, durableReceipts: receipts.length,
      duplicateAckCount, missingAcknowledged: missingAcknowledged.slice(0, 10),
      unexpectedReceipts: unexpectedReceipts.slice(0, 10), wrongOrder: wrongOrder.slice(0, 10),
      liveSamples, liveEvents, orphanCounts };
  } finally { db.close(); }
}

export async function benchmark(args = []) {
  if (NATIVE_NODE < 24) throw new Error('Node 24+ required');
  const config = parseOptions(args);
  const root = mkdtempSync(join(tmpdir(), 'velance-p4-mixed-'));
  const dbPath = join(root, 'fixture.db');
  const backupDir = join(root, 'backups');
  mkdirSync(backupDir, { mode: 0o700 });
  let child;
  const agent = new Agent({ keepAlive: true, maxSockets: 96 });
  const errors = [], resources = [], ingest = [], reads = [], acked = [], lag = [];
  const pendingPosts = new Set(), pendingReads = new Set();
  let postDrops = 0, readDrops = 0, peakPosts = 0, peakReads = 0, backup, fault;
  const total = config.duration * config.rate;
  try {
    const seed = await prepareFixture(dbPath, config.days);
    child = await launchChild(dbPath, resources, errors);
    const initialPort = child.port;
    const epoch = Date.now();
    const first = performance.now();
    const end = first + config.duration * 1000;
    const startedBySecond = new Map();
    const schedulePost = async () => {
      for (let index = 0; index < total; index++) {
        const scheduled = first + index * 1000 / config.rate;
        if (scheduled > performance.now()) await wait(scheduled - performance.now());
        lag.push(performance.now() - scheduled);
        if (pendingPosts.size >= MAX_POST_PENDING) { postDrops++; continue; }
        const batch = batchFor(index, epoch, config.rate);
        const second = Math.floor((performance.now() - first) / 1000);
        startedBySecond.set(second, (startedBySecond.get(second) || 0) + 1);
        const job = checkedRequest(initialPort, { path: '/api/telemetry', type: 'telemetry', body: batch.body, agent, scheduled })
          .then(r => { ingest.push(r); if (r.kind === 'response' && r.status === 200) acked.push(batch); })
          .finally(() => pendingPosts.delete(job));
        pendingPosts.add(job); peakPosts = Math.max(peakPosts, pendingPosts.size);
      }
      await Promise.all(pendingPosts);
    };
    const scheduleReads = async () => {
      let tick = 0;
      for (let at = first; at < end; at += 1000, tick++) {
        if (at > performance.now()) await wait(at - performance.now());
        const routes = [
          ['/api/summary?hours=24', 'summary'],
          ['/api/sessions?limit=50', 'sessions'],
          ['/health/ready', 'ready'],
          ['/metrics', 'metrics']
        ];
        if (tick % 2 === 1 && acked.length) {
          const chosen = acked[tick % acked.length];
          routes.push([`/api/sessions/${chosen.id}`, 'detail']);
        }
        for (const [path, type] of routes) {
          if (pendingReads.size >= MAX_READ_PENDING) { readDrops++; continue; }
          const job = checkedRequest(initialPort, { path, type, agent, scheduled: at })
            .then(r => reads.push(r)).finally(() => pendingReads.delete(job));
          pendingReads.add(job); peakReads = Math.max(peakReads, pendingReads.size);
        }
      }
      await Promise.all(pendingReads);
    };
    const backupConcurrent = (async () => {
      await wait(Math.max(0, first + config.duration * 1000 / 3 - performance.now()));
      const ackBefore = acked.length;
      const start = performance.now();
      try {
        const result = await runOperation('backup', { dbPath, dir: backupDir });
        const verified = await runOperation('verify', { file: result.file });
        const snapshot = { attempted: true, verified: verified.verified === true,
          durationMs: performance.now() - start, bytes: statSync(result.file).size,
          ackBefore, ackAtFinish: acked.length, ackDuring: Math.max(0, acked.length - ackBefore),
          counts: verified.manifest.counts };
        return snapshot;
      } catch (error) {
        return { attempted: true, verified: false, error: error.code || 'BACKUP_FAILED',
          durationMs: performance.now() - start, ackBefore, ackAtFinish: acked.length };
      }
    })();
    await Promise.all([schedulePost(), scheduleReads()]);
    backup = await backupConcurrent;
    // Fault injection is deliberately AFTER all steady-state requests have settled,
    // so the ordinary success denominator cannot include the expected SIGKILL.
    const beforeFault = verifyDatabase(dbPath, seed, acked);
    const precondition = { allSettled: pendingPosts.size === 0 && pendingReads.size === 0,
      acknowledged: acked.length, durableBeforeKill: beforeFault.ok };
    if (!precondition.allSettled || !precondition.durableBeforeKill || !acked.length) {
      fault = { injected: false, passed: false, reason: 'PRECONDITION_NOT_MET', precondition };
    } else {
      const selected = acked.find(item => item.seq === 1) ?? acked[0];
      const killed = await child.stop('SIGKILL');
      child = null;
      const intentionallyKilled = killed.signal === 'SIGKILL';
      const afterCrash = verifyDatabase(dbPath, seed, acked);
      child = await launchChild(dbPath, resources, errors);
      const ready = await checkedRequest(child.port, { path: '/health/ready', type: 'ready', agent });
      const readBack = await checkedRequest(child.port, { path: `/api/sessions/${selected.id}`, type: 'detail', agent });
      const replay = await checkedRequest(child.port, { path: '/api/telemetry', type: 'telemetry', body: selected.body, agent });
      const afterReplay = verifyDatabase(dbPath, seed, acked);
      // Last-sequence advance after restart confirms persisted ordering state.
      const seq = 3;
      const next = { id: selected.id, seq, key: `${selected.id}:${seq}`,
        body: JSON.stringify({ ...JSON.parse(selected.body), seq,
          samples: [0, 1, 2].map(n => ({ t: seq * 4000 + n * 1000, phase: 'browse', fps: 60,
            renderAvg: 2, renderP95: 3, loaded: 16, drawCalls: 100, triangles: 10000 })),
          events: [{ t: seq * 4000 + 100, type: 'paint', data: { i: seq } }] }) };
      const advance = await checkedRequest(child.port, { path: '/api/telemetry', type: 'telemetry', body: next.body, agent });
      const afterAdvance = verifyDatabase(dbPath, seed, acked, { probeReceipts: [next] });
      const readyOK = ready.kind === 'response' && ready.status === 200;
      const readOK = readBack.kind === 'response' && readBack.status === 200;
      const replayOK = replay.kind === 'response' && replay.status === 200 && afterReplay.ok
        && JSON.stringify(afterReplay.counts) === JSON.stringify(afterCrash.counts);
      const advanceOK = advance.kind === 'response' && advance.status === 200 && afterAdvance.ok;
      fault = { injected: true, isolatedFromSteadyState: true, signal: killed.signal,
        precondition, restartReady: readyOK, detailRecovered: readOK,
        replay: { status: replay.status, kind: replay.kind, idempotent: replayOK },
        orderedAdvance: { status: advance.status, kind: advance.kind, seq, persisted: advanceOK },
        afterCrashIntegrity: afterCrash.ok, afterReplayIntegrity: afterReplay.ok,
        passed: intentionallyKilled && afterCrash.ok && readyOK && readOK && replayOK && advanceOK };
    }
    await child?.stop(); child = null;
    const final = verifyDatabase(dbPath, seed, acked, { probeReceipts: fault?.injected ? [{ id: acked.find(item => item.seq === 1)?.id ?? acked[0].id,
      seq: 3, key: `${acked.find(item => item.seq === 1)?.id ?? acked[0].id}:3` }] : [] });
    const completedAck = ingest.filter(r => r.kind === 'response' && r.status === 200);
    const offeredSuccess = total ? completedAck.length / total : 0;
    const classified429 = ingest.filter(r => r.kind === 'response' && r.status === 429);
    const code429 = classified429.filter(r => ['RATE_LIMIT', 'DB_QUEUE_FULL', 'UPLOAD_CAPACITY'].includes(r.code));
    const classified503 = ingest.filter(r => r.kind === 'response' && r.status === 503);
    const perRead = Object.fromEntries([...new Set(reads.map(r => r.type))].map(type => {
      const group = reads.filter(r => r.type === type);
      return [type, { count: group.length, ...tally(group), latencyMs: stats(group.map(r => r.latencyMs)) }];
    }));
    const readsOK = reads.length > 0 && reads.every(r => r.kind === 'response' && r.status === 200) && readDrops === 0;
    const readLatency = stats(reads.map(r => r.latencyMs));
    const ackLatency = stats(completedAck.map(r => r.latencyMs));
    const rss = stats(resources.map(r => r.rssBytes));
    const loop = stats(resources.map(r => r.loopP99Ms));
    const gates = {
      validOffered99_9pct: offeredSuccess >= .999,
      ackP95Under150ms: ackLatency.p95 !== null && ackLatency.p95 < 150,
      ackP99Under300ms: ackLatency.p99 !== null && ackLatency.p99 < 300,
      mixedReadsP95Under500ms: readsOK && readLatency.p95 < 500,
      rssUnder512MiB: rss.max !== null && rss.max <= 512 * 1024 * 1024,
      eventLoopP99Under50ms: loop.max !== null && loop.max <= 50,
      verifiedConcurrentBackup: backup?.verified === true && backup.ackBefore > 0
        && backup.ackBefore < total && (config.days < 3 || backup.ackDuring > 0),
      injectedFaultRecovery: fault?.passed === true,
      durableSQLite: final.ok
    };
    gates.overall = Object.values(gates).every(Boolean);
    return {
      measuredAt: new Date().toISOString(), environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
      profile: { durationSeconds: config.duration, offeredRatePerSecond: config.rate, seededDays: config.days,
        seeds: seed, requested: total, maxPendingPosts: MAX_POST_PENDING, maxPendingReads: MAX_READ_PENDING,
        requestTimeoutMs: REQUEST_TIMEOUT_MS, scheduling: 'absolute monotonic open-loop, no retries in steady state',
        faultSeparation: 'SIGKILL occurs only after steady-state requests settle and persisted ACKs verified' },
      ingestion: { offered: total, issued: ingest.length, droppedBeforeSend: postDrops, peakPending: peakPosts,
        completed: ingest.length, acknowledged: completedAck.length, successFractionOfAllOffered: offeredSuccess,
        expected429: code429.length, unexpected429: classified429.length - code429.length, errors503: classified503.length,
        timeout: ingest.filter(r => r.kind === 'timeout').length, network: ingest.filter(r => r.kind === 'network_error').length,
        incomplete: ingest.filter(r => ['invalid_response', 'incomplete_response'].includes(r.kind)).length,
        duplicateAccepted: completedAck.length - new Set(acked.map(batch => batch.key)).size,
        receiptsAcknowledged: new Set(acked.map(batch => batch.key)).size,
        ...tally(ingest), latencyMs: ackLatency, offeredCompletionMs: stats(ingest.map(r => r.latencyMs)),
        wireLatencyMs: stats(completedAck.map(r => r.wireMs)), scheduleLagMs: stats(lag),
        startedPerSecond: [...startedBySecond].sort((a, b) => a[0] - b[0]) },
      reads: { offered: reads.length + readDrops, completed: reads.length, localDrops: readDrops, peakPending: peakReads,
        success: reads.filter(r => r.kind === 'response' && r.status === 200).length,
        latencyMs: readLatency, byRoute: perRead, ...tally(reads) },
      resources: { sampleCount: resources.length, rssBytes: rss, eventLoopP99Ms: loop },
      backup, fault, verification: final, gates,
      stderrSamples: errors.slice(0, 10),
      caveat: 'Synthetic loopback fixture. Not evidence of CDN distribution, real clients, long-haul network or production uptime.'
    };
  } finally {
    agent.destroy();
    if (child) await child.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes('--child')) {
  await childMain(process.argv.slice(2));
} else if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await benchmark(process.argv.slice(2));
    if (options.out) writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ profile: result.profile, ingestion: result.ingestion,
      reads: { offered: result.reads.offered, success: result.reads.success, latencyMs: result.reads.latencyMs },
      resources: { rssBytes: result.resources.rssBytes, eventLoopP99Ms: result.resources.eventLoopP99Ms },
      backup: result.backup, fault: result.fault, verification: { ok: result.verification.ok, counts: result.verification.counts },
      gates: result.gates, out: options.out }, null, 2));
    if (!result.gates.overall) process.exitCode = 1;
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
