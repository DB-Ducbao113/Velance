import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, createReadStream, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, openStore } from './store.mjs';
import { classify } from './db-worker.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const REAL_DB = resolve(ROOT, 'tools/ops/telemetry.db');
export const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.3, 0.5, 1, 2.5, 5, 10];
const TABLES = ['sessions', 'samples', 'events', 'batches'];
const FORMAT = 'velance-sqlite-backup/1';
const BACKUP_RE = /^velance-\d{8}T\d{6}Z-[0-9a-f]{8}\.db$/;
const STORAGE_CODES = new Set(['ENOSPC', 'EDQUOT', 'EFBIG', 'EIO', 'EROFS', 'EACCES', 'EPERM']);
const LOG_FIELDS = new Set(['requestId', 'route', 'method', 'status', 'code', 'ms', 'role', 'reason', 'bytes', 'ageMs', 'removed', 'signal']);

const escapeLabel = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const formatNumber = value => Number.isFinite(value) ? String(value) : Number.isNaN(value) ? 'NaN' : value > 0 ? '+Inf' : '-Inf';
const labelText = labels => { const entries = Object.entries(labels); return entries.length ? `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}` : ''; };

export function createMetrics({ maxSeries = 2000 } = {}) {
  const families = new Map();
  let total = 0, dropped = 0;
  function family(name, type, help, buckets) {
    let f = families.get(name);
    if (!f) families.set(name, f = { name, type, help, buckets, series: new Map() });
    return f;
  }
  function series(f, labels) {
    const sorted = Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a < b ? -1 : 1));
    const key = JSON.stringify(sorted);
    let s = f.series.get(key);
    if (!s) {
      if (total >= maxSeries) { dropped++; return null; }
      s = f.type === 'histogram' ? { labels: sorted, buckets: f.buckets.map(() => 0), sum: 0, count: 0 } : { labels: sorted, value: 0 };
      f.series.set(key, s); total++;
    }
    return s;
  }
  return {
    counter(name, help) { const f = family(name, 'counter', help); return { inc(labels = {}, n = 1) { const s = series(f, labels); if (s) s.value += n; } }; },
    gauge(name, help) { const f = family(name, 'gauge', help); return { set(labels, value) { const s = series(f, labels); if (s) s.value = value; } }; },
    histogram(name, help, buckets = BUCKETS) {
      const f = family(name, 'histogram', help, buckets);
      return { observe(labels, value) {
        const s = series(f, labels); if (!s) return;
        s.sum += value; s.count++;
        const i = buckets.findIndex(b => value <= b); if (i >= 0) s.buckets[i]++;
      } };
    },
    get dropped() { return dropped; },
    render() {
      const lines = [], all = [...families.values(), { name: 'velance_metrics_series_dropped_total', type: 'counter', help: 'Metric series rejected by the cardinality cap.', series: new Map([['{}', { labels: {}, value: dropped }]]) }];
      for (const f of all.sort((a, b) => a.name < b.name ? -1 : 1)) {
        lines.push(`# HELP ${f.name} ${f.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`, `# TYPE ${f.name} ${f.type}`);
        for (const s of f.series.values()) {
          if (f.type !== 'histogram') { lines.push(`${f.name}${labelText(s.labels)} ${formatNumber(s.value)}`); continue; }
          let cumulative = 0;
          f.buckets.forEach((b, i) => { cumulative += s.buckets[i]; lines.push(`${f.name}_bucket${labelText({ ...s.labels, le: String(b) })} ${cumulative}`); });
          lines.push(`${f.name}_bucket${labelText({ ...s.labels, le: '+Inf' })} ${s.count}`, `${f.name}_sum${labelText(s.labels)} ${formatNumber(s.sum)}`, `${f.name}_count${labelText(s.labels)} ${s.count}`);
        }
      }
      return `${lines.join('\n')}\n`;
    }
  };
}

// Field allowlist is a second line of defence: request data (IP, headers, query, payload, session ids) never reaches a log line.
export function createLogger(write = line => process.stdout.write(line)) {
  return (level, event, fields = {}) => {
    const clean = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!LOG_FIELDS.has(key)) continue;
      if (typeof value === 'string') clean[key] = value.slice(0, 200);
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) clean[key] = value;
    }
    try { write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...clean })}\n`); } catch {}
  };
}

function exists(path) { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function syncPath(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function syncDir(path) { try { syncPath(path); } catch {} }
async function sha256(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
function writeAtomic(path, text) {
  const tmp = join(dirname(path), `.tmp-${basename(path)}-${randomBytes(4).toString('hex')}`);
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (error) { rmSync(tmp, { force: true }); throw error; }
}
const sameContent = (info, manifest) => info.userVersion === manifest.userVersion && JSON.stringify(info.counts) === JSON.stringify(manifest.counts);
function inspect(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') fail(422, 'INTEGRITY_FAILED');
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (TABLES.some(table => !names.has(table))) fail(422, 'BACKUP_SCHEMA_INCOMPLETE');
    const userVersion = db.prepare('PRAGMA user_version').get().user_version;
    if (userVersion !== 2) fail(422, 'BACKUP_SCHEMA_INCOMPATIBLE');
    for (const table of TABLES.slice(1)) {
      const orphan = db.prepare(`SELECT 1 FROM ${table} t WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=t.session_id) LIMIT 1`).get();
      if (orphan) fail(422, 'BACKUP_REFERENTIAL_INTEGRITY');
    }
    return { userVersion, counts: Object.fromEntries(TABLES.map(t => [t, db.prepare(`SELECT count(*) n FROM ${t}`).get().n])) };
  } catch (error) { if (error.status) throw error; fail(422, 'INTEGRITY_FAILED'); }
  finally { db?.close(); }
}
function tableCounts(db) { return Object.fromEntries(TABLES.map(t => [t, db.prepare(`SELECT count(*) n FROM ${t}`).get().n])); }

export function privateDir(dir) {
  dir = resolve(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail(409, 'BACKUP_DIR_NOT_PRIVATE');
  return dir;
}

async function backupTask({ dbPath, dir }) {
  if (!exists(dbPath)) fail(404, 'DB_MISSING');
  dir = privateDir(dir);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const name = `velance-${stamp}-${randomBytes(4).toString('hex')}.db`, tmp = join(dir, `.tmp-${name}`), file = join(dir, name);
  let renamed = false;
  try {
    const source = new DatabaseSync(dbPath, { readOnly: true });
    let createdAt;
    try { source.exec('PRAGMA busy_timeout=5000'); createdAt = Date.now(); await backup(source, tmp, { rate: 2147483647 }); }
    finally { source.close(); }
    chmodSync(tmp, 0o600);
    const info = inspect(tmp), digest = await sha256(tmp);
    syncPath(tmp); renameSync(tmp, file); renamed = true;
    const manifest = { format: FORMAT, file: name, createdAt, bytes: statSync(file).size, sha256: digest, userVersion: info.userVersion, counts: info.counts };
    writeAtomic(`${file}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    syncDir(dir);
    return { file, manifest };
  } catch (error) {
    rmSync(tmp, { force: true });
    if (renamed && !exists(`${file}.manifest.json`)) rmSync(file, { force: true });
    throw error;
  }
}

async function verifyTask({ file }) {
  file = resolve(file);
  let manifest;
  try { manifest = JSON.parse(readFileSync(`${file}.manifest.json`, 'utf8')); }
  catch (error) { fail(422, error.code === 'ENOENT' ? 'BACKUP_MANIFEST_MISSING' : 'BACKUP_MANIFEST_INVALID'); }
  if (manifest?.format !== FORMAT || manifest.file !== basename(file) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1
    || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0 || manifest.createdAt > Date.now() + 300000
    || !/^[0-9a-f]{64}$/.test(manifest.sha256) || manifest.userVersion !== 2 || !manifest.counts || typeof manifest.counts !== 'object'
    || Array.isArray(manifest.counts) || Object.keys(manifest.counts).length !== TABLES.length
    || TABLES.some(table => !Number.isSafeInteger(manifest.counts[table]) || manifest.counts[table] < 0)) fail(422, 'BACKUP_MANIFEST_INVALID');
  let stat;
  try { stat = lstatSync(file); } catch { fail(422, 'BACKUP_MISSING'); }
  if (!stat.isFile()) fail(422, 'BACKUP_MISSING');
  if (stat.size !== manifest.bytes) fail(422, 'SIZE_MISMATCH');
  if (await sha256(file) !== manifest.sha256) fail(422, 'CHECKSUM_MISMATCH');
  if (!sameContent(inspect(file), manifest)) fail(422, 'CONTENT_MISMATCH');
  return { file, manifest, verified: true };
}

async function restoreTask({ file, to }) {
  const { manifest } = await verifyTask({ file });
  to = resolve(to);
  if (['', '-wal', '-shm', '-journal'].some(suffix => exists(to + suffix))) fail(409, 'RESTORE_DEST_EXISTS');
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try { copyFileSync(resolve(file), to, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code === 'EEXIST') fail(409, 'RESTORE_DEST_EXISTS'); throw error; }
  try {
    chmodSync(to, 0o600); syncPath(to);
    if (await sha256(to) !== manifest.sha256 || !sameContent(inspect(to), manifest)) fail(500, 'RESTORE_COPY_MISMATCH');
    syncDir(dirname(to));
    return { file: resolve(file), to, manifest };
  } catch (error) { rmSync(to, { force: true }); throw error; }
}

async function retentionTask({ dbPath, apply = false, backupDir = null }) {
  if (!exists(dbPath)) fail(404, 'DB_MISSING');
  if (!apply) {
    const store = await openStore(dbPath, true);
    try { return { apply: false, ...(await store.call('retention', { apply: false })) }; } finally { store.close(); }
  }
  if (!backupDir) fail(400, 'BACKUP_DIR_REQUIRED');
  const saved = await backupTask({ dbPath, dir: backupDir });
  await verifyTask({ file: saved.file });
  const store = await openStore(dbPath, false);
  try {
    const plan = await store.call('retention', { apply: false }), before = tableCounts(store.db);
    let deleted = 0;
    for (;;) {
      const { deleted: n } = await store.call('retention', { apply: true });
      deleted += n;
      if (!n) break;
      await new Promise(r => setTimeout(r, 25));
    }
    const orphans = ['samples', 'events', 'batches'].reduce((n, t) => n + store.db.prepare(`SELECT count(*) n FROM ${t} WHERE session_id NOT IN (SELECT id FROM sessions)`).get().n, 0);
    return { apply: true, backup: saved.file, cutoff: plan.cutoff, eligible: plan.eligible, rows: plan.rows, deleted, before, after: tableCounts(store.db), orphans };
  } finally { store.close(); }
}

const TASKS = { backup: backupTask, verify: verifyTask, restore: restoreTask, retention: retentionTask };
function errorOf(error) {
  if (error.status) return { status: error.status, code: error.code };
  if (STORAGE_CODES.has(error.code)) return { status: 503, code: 'STORAGE_FAILURE' };
  return classify(error);
}

if (!isMainThread && workerData?.velanceOperation) {
  const { task, args } = workerData.velanceOperation;
  try { parentPort.postMessage({ result: await TASKS[task](args) }); }
  catch (error) { parentPort.postMessage({ error: errorOf(error) }); }
}

export function runOperation(task, args, { signal } = {}) {
  return new Promise((ok, no) => {
    if (!TASKS[task]) { no(Object.assign(new Error('BAD_OPERATION'), { status: 400, code: 'BAD_OPERATION' })); return; }
    const worker = new Worker(new URL(import.meta.url), { workerData: { velanceOperation: { task, args } }, execArgv: [] });
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); fn(value); };
    const failure = code => Object.assign(new Error(code), { status: code === 'OPERATION_ABORTED' ? 503 : 500, code });
    const abort = () => { void worker.terminate(); finish(no, failure('OPERATION_ABORTED')); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', m => m.error ? finish(no, Object.assign(new Error(m.error.code), m.error)) : finish(ok, m.result));
    worker.once('error', () => finish(no, failure('OPERATION_FAILED')));
    worker.once('exit', () => finish(no, failure('OPERATION_FAILED')));
  });
}

export function listBackups(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (!BACKUP_RE.test(name)) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(dir, `${name}.manifest.json`), 'utf8'));
      if (manifest.format === FORMAT && manifest.file === name && Number.isSafeInteger(manifest.createdAt)) found.push({ file: join(dir, name), name, createdAt: manifest.createdAt, bytes: manifest.bytes });
    } catch {}
  }
  return found.sort((a, b) => a.createdAt - b.createdAt || (a.name < b.name ? -1 : 1));
}
export const latestBackup = dir => listBackups(dir).at(-1) ?? null;
export function rotate(dir, keep) {
  const found = listBackups(dir), removed = found.slice(0, Math.max(0, found.length - keep));
  for (const b of removed) { rmSync(b.file, { force: true }); rmSync(`${b.file}.manifest.json`, { force: true }); }
  return removed.map(b => b.name);
}
// Use one scheduler per private backup directory. Workers clean up their own temporary
// files on ordinary failures; forcibly terminated workers can leave a temp artifact.
// Never sweep other processes' temp files during start-up or shutdown.
export function startBackupScheduler({ dbPath, dir, intervalMs = 3600000, keep = 168, log = () => {}, onResult = () => {} }) {
  if (!Number.isSafeInteger(keep) || keep < 1) fail(400, 'BAD_BACKUP_KEEP');
  dir = privateDir(dir);
  // A manifest on disk is not evidence of a verified backup.
  const state = { lastSuccess: null, lastFailure: null, lastError: null };
  const age = () => state.lastSuccess == null ? null : Date.now() - state.lastSuccess;
  let running = null, controller = null, stopped = false, initial = null;
  const verifyController = new AbortController();
  async function attempt() {
    controller = new AbortController();
    const started = performance.now();
    try {
      const result = await runOperation('backup', { dbPath, dir }, { signal: controller.signal });
      state.lastSuccess = result.manifest.createdAt;
      let removed = 0;
      try { removed = rotate(dir, keep).length; } catch { log('warn', 'backup_rotate_failed', {}); }
      log('info', 'backup_complete', { file: result.manifest.file, bytes: result.manifest.bytes, ms: Math.round(performance.now() - started), removed });
      onResult(null, result);
      return result;
    } catch (error) {
      state.lastFailure = Date.now(); state.lastError = error.code || 'INTERNAL';
      log(stopped ? 'warn' : 'error', 'backup_failed', { code: state.lastError });
      onResult(error);
      return null;
    } finally { running = null; controller = null; }
  }
  const run = () => stopped ? Promise.resolve(null) : (running ??= attempt());
  const timer = setInterval(run, intervalMs); timer.unref();
  const bootstrap = (async () => {
    for (const candidate of listBackups(dir).reverse()) {
      if (stopped) return;
      try {
        await runOperation('verify', { file: candidate.file }, { signal: verifyController.signal });
        state.lastSuccess = Math.max(state.lastSuccess ?? 0, candidate.createdAt);
        break;
      } catch (error) {
        if (stopped) return;
        log('warn', 'backup_verify_failed', { code: error.code || 'INTERNAL' });
      }
    }
    if (stopped) return;
    if (age() == null || age() > 2 * 3600000) log('warn', 'backup_stale', { ageMs: age() });
    if (age() == null || age() >= intervalMs) { initial = setTimeout(run, 1000); initial.unref(); }
  })();
  return { dir, state, age, run,
    async stop() { stopped = true; clearInterval(timer); clearTimeout(initial); verifyController.abort(); controller?.abort(); await bootstrap; await running; } };
}

if (isMainThread && import.meta.main) {
  const usage = 'Usage: node tools/ops/operations.mjs backup --db <db> --dir <dir> | verify --file <backup.db> | restore --file <backup.db> --to <new.db> | retention --db <db> [--apply --backup-dir <dir> [--allow-real-db]]';
  const [command, ...rest] = process.argv.slice(2), options = {};
  try {
    for (let i = 0; i < rest.length; i++) {
      const key = rest[i].startsWith('--') ? rest[i].slice(2) : null;
      if (key === 'apply' || key === 'allow-real-db') { options[key] = true; continue; }
      if (!['db', 'dir', 'file', 'to', 'backup-dir'].includes(key) || !rest[i + 1] || rest[i + 1].startsWith('--')) fail(400, 'USAGE');
      options[key] = resolve(rest[++i]);
    }
    const required = { backup: ['db', 'dir'], verify: ['file'], restore: ['file', 'to'], retention: ['db'] }[command];
    if (!required || required.some(k => !options[k]) || (options.apply && command !== 'retention')) fail(400, 'USAGE');
    const real = path => { try { return realpathSync(path) === realpathSync(REAL_DB); } catch { return false; } };
    if (command === 'retention' && options.apply && real(options.db) && !options['allow-real-db']) fail(403, 'REAL_DB_CONFIRMATION_REQUIRED');
    const args = { backup: { dbPath: options.db, dir: options.dir }, verify: { file: options.file }, restore: { file: options.file, to: options.to },
      retention: { dbPath: options.db, apply: !!options.apply, backupDir: options['backup-dir'] ?? null } }[command];
    process.stdout.write(`${JSON.stringify(await TASKS[command](args), null, 2)}\n`);
  } catch (error) {
    const { code } = errorOf(error);
    process.stderr.write(`${JSON.stringify({ error: code, ...(code === 'USAGE' ? { usage } : {}) })}\n`);
    process.exitCode = 1;
  }
}
