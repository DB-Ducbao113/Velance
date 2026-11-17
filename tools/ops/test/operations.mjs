import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DAY, openStore } from '../store.mjs';
import { createLogger, createMetrics, listBackups, rotate, runOperation, startBackupScheduler } from '../operations.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'velance-operations-'));
  const dbPath = join(root, 'fixture.db'), dir = join(root, 'backups');
  mkdirSync(dir, { mode: 0o700 });
  const store = await openStore(dbPath);
  try {
    const insertSession = store.db.prepare('INSERT INTO sessions(id,started_at,received_at,context,milestones,backend,mobile,final,last_seq) VALUES(?,?,?,?,?,?,?,?,?)');
    const insertSample = store.db.prepare('INSERT INTO samples(session_id,t,phase,fps) VALUES(?,?,?,?)');
    const insertEvent = store.db.prepare('INSERT INTO events(session_id,t,type,data) VALUES(?,?,?,?)');
    const insertBatch = store.db.prepare('INSERT INTO batches(session_id,seq) VALUES(?,?)');
    const now = Date.now();
    store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [id, receivedAt] of [['expired-0001', now - 40 * DAY], ['expired-0002', now - 35 * DAY], ['current-0001', now]]) {
        insertSession.run(id, receivedAt, receivedAt, '{}', '{}', 'webgpu', 0, null, 0);
        insertSample.run(id, 1, 'browse', 60);
        insertEvent.run(id, 1, 'paint', '{"i":1}');
        insertBatch.run(id, 0);
      }
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  } finally { store.close(); }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dbPath, dir };
}

function rows(dbPath, table) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(`SELECT count(*) n FROM ${table}`).get().n; } finally { db.close(); }
}

const codeIs = code => error => error?.code === code;

test('worker backup, manifest verification and safe restore use private temporary files', async t => {
  const { dbPath, dir, root } = await fixture(t);
  const result = await runOperation('backup', { dbPath, dir });
  const { file, manifest } = result;
  assert(file.startsWith(dir)); assert.equal(manifest.format, 'velance-sqlite-backup/1');
  assert.equal(manifest.file, file.split('/').at(-1)); assert.equal(manifest.counts.sessions, 3);
  assert.equal(manifest.counts.samples, 3); assert.equal(manifest.counts.events, 3);
  assert.equal(manifest.counts.batches, 3);
  assert.equal(statSync(file).mode & 0o077, 0, 'backup must be private');
  assert.equal(statSync(`${file}.manifest.json`).mode & 0o077, 0, 'manifest must be private');
  assert.equal((await runOperation('verify', { file })).verified, true);
  const destination = join(root, 'restored.db');
  assert.equal((await runOperation('restore', { file, to: destination })).to, destination);
  for (const table of ['sessions', 'samples', 'events', 'batches']) assert.equal(rows(destination, table), 3, table);
  assert.equal(statSync(destination).mode & 0o077, 0, 'restored DB must be private');
  await assert.rejects(runOperation('restore', { file, to: destination }), codeIs('RESTORE_DEST_EXISTS'));
  rmSync(destination);
  writeFileSync(`${destination}-wal`, 'reserved');
  await assert.rejects(runOperation('restore', { file, to: destination }), codeIs('RESTORE_DEST_EXISTS'));
  assert.equal(existsSync(destination), false, 'restore must not overwrite or create destination with WAL collision');
  rmSync(`${destination}-wal`);

  const intact = readFileSync(file);
  appendFileSync(file, Buffer.from([0]));
  await assert.rejects(runOperation('verify', { file }), codeIs('SIZE_MISMATCH'));
  writeFileSync(file, intact);
  assert.equal((await runOperation('verify', { file })).verified, true);
  const corrupted = Buffer.from(intact);
  corrupted[corrupted.length - 1] ^= 1;
  writeFileSync(file, corrupted);
  await assert.rejects(runOperation('verify', { file }), codeIs('CHECKSUM_MISMATCH'));
  writeFileSync(file, intact);
  const originalManifest = readFileSync(`${file}.manifest.json`);
  const mismatched = JSON.parse(originalManifest.toString());
  mismatched.counts.sessions = 100;
  writeFileSync(`${file}.manifest.json`, JSON.stringify(mismatched));
  await assert.rejects(runOperation('verify', { file }), codeIs('CONTENT_MISMATCH'));
  mismatched.counts.sessions = 3;
  mismatched.createdAt = Date.now() + 3600000;
  writeFileSync(`${file}.manifest.json`, JSON.stringify(mismatched));
  await assert.rejects(runOperation('verify', { file }), codeIs('BACKUP_MANIFEST_INVALID'));
  writeFileSync(`${file}.manifest.json`, originalManifest);
  writeFileSync(`${file}.manifest.json`, '{');
  await assert.rejects(runOperation('verify', { file }), codeIs('BACKUP_MANIFEST_INVALID'));
  writeFileSync(`${file}.manifest.json`, originalManifest);
  rmSync(`${file}.manifest.json`);
  await assert.rejects(runOperation('verify', { file }), codeIs('BACKUP_MANIFEST_MISSING'));
});

test('retention dry run is non-destructive; apply snapshots first and preserves current sessions', async t => {
  const { dbPath, dir, root } = await fixture(t);
  const dry = await runOperation('retention', { dbPath, apply: false });
  assert.equal(dry.apply, false); assert.equal(dry.eligible, 2); assert.equal(dry.deleted, 0);
  assert.deepEqual(dry.rows, { samples: 2, events: 2, batches: 2 });
  assert.equal(rows(dbPath, 'sessions'), 3);
  assert.deepEqual(listBackups(dir), [], 'dry run must not create backups');
  await assert.rejects(runOperation('retention', { dbPath, apply: true }), codeIs('BACKUP_DIR_REQUIRED'));
  assert.equal(rows(dbPath, 'sessions'), 3, 'refused apply must not modify data');
  chmodSync(dir, 0o755);
  await assert.rejects(runOperation('retention', { dbPath, apply: true, backupDir: dir }), codeIs('BACKUP_DIR_NOT_PRIVATE'));
  assert.equal(rows(dbPath, 'sessions'), 3, 'failed pre-deletion backup must leave all rows intact');
  chmodSync(dir, 0o700);
  const result = await runOperation('retention', { dbPath, apply: true, backupDir: dir });
  assert.equal(result.apply, true); assert.equal(result.eligible, 2); assert.equal(result.deleted, 2);
  assert.deepEqual(result.before, { sessions: 3, samples: 3, events: 3, batches: 3 });
  assert.deepEqual(result.after, { sessions: 1, samples: 1, events: 1, batches: 1 });
  assert.equal(result.orphans, 0);
  assert.equal((await runOperation('verify', { file: result.backup })).verified, true);
  const restored = join(root, 'retention-preapply.db');
  await runOperation('restore', { file: result.backup, to: restored });
  for (const table of ['sessions', 'samples', 'events', 'batches']) assert.equal(rows(restored, table), 3, table);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { assert.deepEqual(db.prepare('SELECT id FROM sessions').all().map(row => row.id), ['current-0001']); }
  finally { db.close(); }
  assert.equal((await runOperation('retention', { dbPath, apply: false })).eligible, 0);
});

test('backup directory permissions, missing database and operation aborts fail safely', async t => {
  const { root, dbPath, dir } = await fixture(t);
  await assert.rejects(runOperation('backup', { dbPath: join(root, 'missing.db'), dir }), codeIs('DB_MISSING'));
  chmodSync(dir, 0o755);
  await assert.rejects(runOperation('backup', { dbPath, dir }), codeIs('BACKUP_DIR_NOT_PRIVATE'));
  chmodSync(dir, 0o700);
  assert.equal(rows(dbPath, 'sessions'), 3);
  await assert.rejects(runOperation('unsupported', { dbPath }), codeIs('BAD_OPERATION'));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(runOperation('backup', { dbPath, dir }, { signal: abort.signal }), codeIs('OPERATION_ABORTED'));
  assert.equal(rows(dbPath, 'sessions'), 3);
});

test('rotation removes only oldest matching backups and manifests', async t => {
  const { dbPath, dir } = await fixture(t);
  for (let i = 0; i < 3; i++) await runOperation('backup', { dbPath, dir });
  writeFileSync(join(dir, 'unrelated.txt'), 'do not delete');
  const before = listBackups(dir);
  assert.equal(before.length, 3);
  const removed = rotate(dir, 1);
  assert.deepEqual(removed, before.slice(0, 2).map(backup => backup.name));
  assert.deepEqual(listBackups(dir), before.slice(2));
  for (const entry of before.slice(0, 2)) {
    assert.equal(existsSync(entry.file), false); assert.equal(existsSync(`${entry.file}.manifest.json`), false);
  }
  assert.equal((await runOperation('verify', { file: before[2].file })).verified, true);
  assert.equal(existsSync(join(dir, 'unrelated.txt')), true);
});

test('scheduler bootstrap skips corrupted newest snapshot and trusts verified older backup', async t => {
  const { dbPath, dir } = await fixture(t);
  const older = await runOperation('backup', { dbPath, dir });
  const newer = await runOperation('backup', { dbPath, dir });
  const createdAt = Date.now();
  // Deliberately distinguish manifest timestamps even on hosts with coarse clocks.
  const setCreatedAt = (file, time) => {
    const path = `${file}.manifest.json`;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.createdAt = time;
    writeFileSync(path, JSON.stringify(manifest));
  };
  setCreatedAt(older.file, createdAt - 60_000);
  setCreatedAt(newer.file, createdAt - 5_000);
  assert.deepEqual(listBackups(dir).map(b => b.file), [older.file, newer.file]);
  const corrupted = readFileSync(newer.file);
  corrupted[corrupted.length - 1] ^= 1;
  writeFileSync(newer.file, corrupted); // Same-size damage forces a checksum failure.
  await assert.rejects(runOperation('verify', { file: newer.file }), codeIs('CHECKSUM_MISMATCH'));
  assert.equal((await runOperation('verify', { file: older.file })).verified, true);
  const logs = [], results = [];
  const scheduler = startBackupScheduler({ dbPath, dir, intervalMs: 3600000,
    log: (level, event, fields) => logs.push({ level, event, fields }),
    onResult: (error, result) => results.push({ error, result }) });
  try {
    const deadline = Date.now() + 3000;
    while (scheduler.state.lastSuccess == null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(scheduler.state.lastSuccess, createdAt - 60_000, 'bootstrap must use the last verified backup');
    assert(logs.some(row => row.level === 'warn' && row.event === 'backup_verify_failed' && row.fields.code === 'CHECKSUM_MISMATCH'));
    assert.equal(scheduler.state.lastFailure, null);
    assert.deepEqual(results, [], 'recent older backup must not trigger an immediate new backup');
    assert.deepEqual(listBackups(dir).map(b => b.file), [older.file, newer.file], 'bootstrap must leave backup files untouched');
  } finally { await scheduler.stop(); }
});

test('metric histograms are cumulative; cardinality and structured-log fields are bounded', () => {
  const metrics = createMetrics();
  const hist = metrics.histogram('test_latency_seconds', 'latency', [0.5, 1]);
  for (const value of [0.25, 0.8, 2]) hist.observe({ route: '/test' }, value);
  const render = metrics.render();
  assert.match(render, /test_latency_seconds_bucket\{route="\/test",le="0.5"\} 1/);
  assert.match(render, /test_latency_seconds_bucket\{route="\/test",le="1"\} 2/);
  assert.match(render, /test_latency_seconds_bucket\{route="\/test",le="\+Inf"\} 3/);
  assert.match(render, /test_latency_seconds_count\{route="\/test"\} 3/);
  const capped = createMetrics({ maxSeries: 2 });
  const counter = capped.counter('test_count_total', 'count');
  counter.inc({ kind: 'a' }, 2); counter.inc({ kind: 'b' }); counter.inc({ kind: 'c' });
  assert.equal(capped.dropped, 1);
  assert.match(capped.render(), /velance_metrics_series_dropped_total 1/);
  assert.doesNotMatch(capped.render(), /kind="c"/);
  const lines = [];
  const log = createLogger(line => lines.push(line));
  log('warn', 'request', { requestId: 'x', reason: 'a'.repeat(250), arbitrary: 'SECRET_VALUE', body: 'SECRET_BODY' });
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, 'request'); assert.equal(event.requestId, 'x'); assert.equal(event.reason.length, 200);
  assert(!JSON.stringify(event).includes('SECRET_VALUE')); assert(!JSON.stringify(event).includes('SECRET_BODY'));
  assert.doesNotThrow(() => createLogger(() => { throw new Error('log IO failure'); })('error', 'test'));
});
