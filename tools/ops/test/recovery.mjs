import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createOpsServer } from '../server.mjs';
import { runOperation } from '../operations.mjs';
import { openStore } from '../store.mjs';

const post = (port, batch) => new Promise((resolve, reject) => {
  const body = Buffer.from(JSON.stringify(batch));
  const req = request({ hostname: '127.0.0.1', port, method: 'POST', path: '/api/telemetry',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }, agent: false }, res => {
    const parts = [];
    res.on('data', chunk => parts.push(chunk));
    res.once('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }));
    res.once('error', reject);
  });
  req.once('error', reject);
  req.setTimeout(5000, () => req.destroy(new Error('fixture request timeout')));
  req.end(body);
});

const batch = (seq, startedAt) => ({ id: 'crash-test-session-0001', seq, startedAt,
  milestones: { gateShown: 0, firstCar: 70 }, backend: 'webgpu',
  samples: [{ t: seq, phase: 'browse', fps: 60 }], events: [{ t: seq, type: 'paint', data: { i: 1 } }] });

test('ACKed receipts survive SIGKILL of a fixture child and duplicate replay after restart', { skip: process.platform === 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'velance-crash-drill-')), dbPath = join(root, 'fixture.db');
  let child, server;
  t.after(async () => {
    if (child?.exitCode == null && child?.signalCode == null) {
      child.kill('SIGKILL'); await once(child, 'exit').catch(() => {});
    }
    if (server) await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const startedAt = Date.now() - 1000;
  child = fork(new URL('./fixtures/crash-child.mjs', import.meta.url), [JSON.stringify({ root, dbPath })],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const port = await new Promise((resolve, reject) => {
    const finish = (fn, value) => { clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => finish(reject, new Error('Fixture startup deadline exceeded')), 5000);
    child.once('error', error => finish(reject, error));
    child.once('exit', (code, signal) => finish(reject, new Error(`Fixture child exited before ready: ${code ?? signal}: ${stderr}`)));
    child.on('message', message => { if (message.type === 'ready') finish(resolve, message.port); });
  });
  for (const seq of [0, 1, 2]) assert.equal((await post(port, batch(seq, startedAt))).status, 200);
  assert(child.kill('SIGKILL'), 'Must kill only owned fixture process');
  await once(child, 'exit');

  const disk = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.deepEqual(['sessions', 'batches', 'samples', 'events'].map(table => disk.prepare(`SELECT count(*) AS n FROM ${table}`).get().n), [1, 3, 3, 3]);
    assert.equal(disk.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { disk.close(); }

  server = await createOpsServer({ root, dbPath });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  assert.equal((await post(server.address().port, batch(2, startedAt))).status, 200, 'Duplicate ACK after crash');
  assert.equal((await post(server.address().port, batch(3, startedAt))).status, 200, 'New receipt after crash');
  const check = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.deepEqual(['sessions', 'batches', 'samples', 'events'].map(table => check.prepare(`SELECT count(*) AS n FROM ${table}`).get().n), [1, 4, 4, 4]);
  } finally { check.close(); }
});

test('backup during fixture HTTP ingestion restores an internally consistent committed snapshot', async t => {
  const root = mkdtempSync(join(tmpdir(), 'velance-backup-ingest-'));
  const dbPath = join(root, 'fixture.db'), dir = join(root, 'backups');
  mkdirSync(dir, { mode: 0o700 });
  const server = await createOpsServer({ root, dbPath });
  t.after(async () => { await server.shutdown(); rmSync(root, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const startedAt = Date.now() - 1000, port = server.address().port;
  for (let seq = 0; seq < 5; seq++) assert.equal((await post(port, batch(seq, startedAt))).status, 200);

  const snapshot = runOperation('backup', { dbPath, dir });
  const writing = (async () => {
    for (let seq = 5; seq < 50; seq++) assert.equal((await post(port, batch(seq, startedAt))).status, 200);
  })();
  const [saved] = await Promise.all([snapshot, writing]);
  assert.equal((await runOperation('verify', { file: saved.file })).verified, true);
  const restored = join(root, 'restored.db');
  await runOperation('restore', { file: saved.file, to: restored });
  const db = new DatabaseSync(restored, { readOnly: true });
  try {
    const rowCounts = ['sessions', 'batches', 'samples', 'events'].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
    assert.equal(rowCounts[0], 1);
    assert(rowCounts[1] >= 5 && rowCounts[1] <= 50);
    assert.deepEqual(rowCounts.slice(1), Array(3).fill(rowCounts[1]), 'Receipt and dependent rows belong to the same SQLite snapshot');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('SELECT count(*) AS n FROM batches WHERE session_id NOT IN (SELECT id FROM sessions)').get().n, 0);
  } finally { db.close(); }
  const restoredServer = await createOpsServer({ root, dbPath: restored });
  try {
    restoredServer.listen(0, '127.0.0.1'); await once(restoredServer, 'listening');
    const response = await fetch(`http://127.0.0.1:${restoredServer.address().port}/api/sessions?limit=50`);
    assert.equal(response.status, 200, 'The restored database must open through the actual read API');
    assert.equal((await response.json()).length, 1);
  } finally { await restoredServer.shutdown(); }
  const live = new DatabaseSync(dbPath, { readOnly: true });
  try { assert.equal(live.prepare('SELECT count(*) AS n FROM batches').get().n, 50); }
  finally { live.close(); }
});

test('temporary SQLite write lock returns a bounded 503 and ingestion recovers after release', async t => {
  const root = mkdtempSync(join(tmpdir(), 'velance-db-lock-')), dbPath = join(root, 'fixture.db');
  const server = await createOpsServer({ root, dbPath });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const lock = new DatabaseSync(dbPath);
  t.after(async () => { lock.close(); await server.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const startedAt = Date.now() - 1000;
  lock.exec('BEGIN IMMEDIATE');
  try {
    const rejected = await post(server.address().port, batch(0, startedAt));
    assert.equal(rejected.status, 503);
    assert.equal(JSON.parse(rejected.text).code, 'DB_BUSY');
  } finally { lock.exec('ROLLBACK'); }
  assert.equal((await post(server.address().port, batch(0, startedAt))).status, 200);
  const disk = new DatabaseSync(dbPath, { readOnly: true });
  try { assert.equal(disk.prepare('SELECT count(*) AS n FROM batches').get().n, 1); }
  finally { disk.close(); }
});

test('read-only temporary database volume prevents startup without creating an alternate writer',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'velance-readonly-drill-')), dbPath = join(root, 'fixture.db');
    try {
      const store = await openStore(dbPath);
      store.close();
      chmodSync(dbPath, 0o444);
      chmodSync(root, 0o555);
      await assert.rejects(createOpsServer({ root, dbPath }),
        error => error?.status === 503 && error?.code === 'DB_STORAGE_FAILURE');
    } finally {
      chmodSync(root, 0o700);
      chmodSync(dbPath, 0o600);
      rmSync(root, { recursive: true, force: true });
    }
  });
