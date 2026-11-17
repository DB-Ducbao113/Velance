import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createOpsServer } from '../server.mjs';

const START = Date.now() - 1000;
const batch = (changes = {}) => ({ id: 'test-session-0001', seq: 0, startedAt: START, milestones: { gateShown: 0, firstCar: 100, allLoaded: 200, enter: 300 }, backend: 'webgpu', samples: [], events: [], ...changes });
const sample = (t, fps = 60) => ({ t, phase: 'browse', fps, loaded: 16, drawCalls: 42, triangles: 120000 });
function send(server, path = '/api/telemetry', { body, method = body === undefined ? 'GET' : 'POST', headers = {}, chunked = false } = {}) {
  return new Promise((ok, no) => {
    const bytes = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) no(error); else ok(value);
    };
    const deadline = setTimeout(() => {
      finish(new Error('request timeout'));
      req.destroy();
    }, 5000);
    const req = request({ host: '127.0.0.1', port: server.address().port, path, method, agent: false,
      headers: { ...(bytes ? { 'Content-Type': 'application/json', ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': bytes.length }) } : {}), ...headers } }, res => {
      const parts = [];
      res.on('data', b => parts.push(b));
      res.on('error', error => finish(error));
      res.on('aborted', () => finish(new Error('response aborted')));
      res.on('close', () => { if (!res.complete) finish(new Error('response closed before completion')); });
      res.on('end', () => {
        if (!res.complete) return finish(new Error('Response must be complete'));
        finish(null, { status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString() });
      });
    });
    req.on('error', error => finish(error));
    if (bytes && chunked) for (let i = 0; i < bytes.length; i += 4096) req.write(bytes.subarray(i, i + 4096));
    req.end(chunked ? undefined : bytes);
  });
}

function sendChunkedOverCap(server) {
  // Incremental uploads respect socket backpressure and stop as soon as the
  // server has received CAP + 1 bytes. No trailing chunks race the early 413.
  const cap = 256 * 1024, chunk = Buffer.alloc(8 * 1024, 32);
  return new Promise((ok, no) => {
    let settled = false, sent = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) { req.destroy(); no(error); } else ok(value);
    };
    const deadline = setTimeout(() => finish(new Error(`chunked upload timed out after ${sent} bytes`)), 5000);
    const req = request({ host: '127.0.0.1', port: server.address().port, path: '/api/telemetry', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('error', error => finish(error));
      res.on('aborted', () => finish(new Error('chunked response aborted')));
      res.on('close', () => { if (!res.complete) finish(new Error('chunked response closed before completion')); });
      res.on('end', () => {
        if (!res.complete) return finish(new Error('chunked response incomplete'));
        finish(null, { status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString(), sent });
      });
    });
    req.on('error', error => finish(error));
    const writeNext = () => {
      while (!settled && sent < cap + 1) {
        const n = Math.min(chunk.length, cap + 1 - sent);
        const ready = req.write(chunk.subarray(0, n));
        sent += n;
        if (sent === cap + 1) return;
        if (!ready) { req.once('drain', writeNext); return; }
      }
    };
    writeNext();
  });
}
async function fixture(t, custom = false, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'velance-server-'));
  const put = (path, text = 'fixture') => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  for (const p of ['index.html', 'ops/index.html', 'ops/ops.css', 'ops/ops.js', 'styles/main.css', 'src/app.js', 'vendor/lib.js', 'vendor/basis.wasm', 'assets/models/car.glb', 'assets/images/car/a.webp', 'assets/environment/a.webp', 'packages/tsl-carpaint/src/index.js', 'packages/tsl-carpaint/demo/index.html', 'packages/tsl-carpaint/demo/app.js', 'tools/render/render.html', '.git/HEAD', '.env', 'assets/models_original/car.glb', 'assets/models_prepared/car.glb', 'assets/images/car/a.png', 'tools/private.js', 'vendor/node_modules/a.js']) put(p);
  const dbPath = join(root, custom ? 'src/secret.js' : 'telemetry.db');
  const server = await createOpsServer({ root, dbPath, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const db = new DatabaseSync(dbPath);
  t.after(async () => { db.close(); if (server.listening) await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); });
  return { root, put, server, dbPath, db };
}
const data = response => JSON.parse(response.text);
const counts = db => ['sessions', 'samples', 'events', 'batches'].map(table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n);

test('static allowlist, MIME, redirects, canonical containment and custom DB', async t => {
  const { root, server, put, dbPath } = await fixture(t, true);
  const routes = { '/': 'text/html', '/ops/': 'text/html', '/ops/ops.js': 'text/javascript', '/ops/ops.css': 'text/css', '/src/app.js': 'text/javascript', '/styles/main.css': 'text/css', '/vendor/lib.js': 'text/javascript', '/vendor/basis.wasm': 'application/wasm', '/assets/models/car.glb': 'model/gltf-binary', '/assets/images/car/a.webp': 'image/webp', '/assets/environment/a.webp': 'image/webp', '/packages/tsl-carpaint/src/index.js': 'text/javascript', '/packages/tsl-carpaint/demo/': 'text/html', '/packages/tsl-carpaint/demo/app.js': 'text/javascript', '/tools/render/render.html': 'text/html' };
  for (const [path, mime] of Object.entries(routes)) for (const method of ['GET', 'HEAD']) {
    const res = await send(server, path, { method }); assert.equal(res.status, 200, path); assert(res.headers['content-type'].startsWith(mime));
    assert.equal(res.headers['x-content-type-options'], 'nosniff'); assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
    if (method === 'HEAD') assert.equal(res.text, '');
  }
  for (const path of ['/ops', '/packages/tsl-carpaint/demo']) { const r = await send(server, `${path}?a=1`); assert.equal(r.status, 308); assert.equal(r.headers.location, `${path}/?a=1`); }
  put('src/secret.js-wal'); put('src/secret.js.backup.js');
  symlinkSync(join(root, 'tools/private.js'), join(root, 'src/inside.js'));
  symlinkSync('/etc/hosts', join(root, 'src/outside.js'));
  symlinkSync(dbPath, join(root, 'src/db-alias.js'));
  for (const p of ['/.git/HEAD', '/.env', '/src/secret.js', '/src/secret.js-wal', '/src/secret.js.backup.js', '/assets/models_original/car.glb', '/assets/models_prepared/car.glb', '/assets/images/car/a.png', '/tools/private.js', '/vendor/node_modules/a.js', '/src/inside.js', '/src/outside.js', '/src/db-alias.js']) assert.equal((await send(server, p)).status, 404, p);
  for (const p of ['/../index.html', '/%2e%2e/index.html', '/src/../app.js', '/src%2f..%2fapp.js', '/src%5capp.js', '/%00', '/%zz', '//bad', '/%2e/index.html']) assert.equal((await send(server, p)).status, 400, p);
  assert.equal((await send(server, '/')).status, 200);
});

test('Host, Origin, Fetch metadata and CLI boundaries', async t => {
  const { server } = await fixture(t);
  for (const host of ['evil.test', 'localhost:1', '127.0.0.1@evil.test', '[::1', '127.0.0.1:99999']) assert.equal((await send(server, '/', { headers: { Host: host } })).status, 400);
  for (const origin of ['null', 'https://evil.test', 'http://localhost:1']) assert.equal((await send(server, '/', { headers: { Origin: origin } })).status, 403);
  assert.equal((await send(server, '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await send(server, '/', { headers: { Origin: `http://127.0.0.1:${server.address().port}` } })).status, 200);
  assert.equal((await send(server, 'http://evil.test/')).status, 400);
  for (const args of [['--host', '0.0.0.0'], ['--port', 'NaN'], ['--port', '-1'], ['--port', '65536']]) {
    const r = spawnSync(process.execPath, ['tools/ops/server.mjs', ...args], { encoding: 'utf8' }); assert.equal(r.status, 1);
  }
});

test('complete 413 at byte cap for fixed and chunked bodies, abort survival, HTTP status contracts', async t => {
  const { server, db } = await fixture(t);
  const cap = 256 * 1024;
  const assert413 = (response, description) => {
    assert.equal(response.status, 413, description);
    assert.match(response.headers['content-type'], /^application\/json/);
    assert.equal(response.headers['content-length'], Buffer.byteLength(response.text).toString(), description);
    assert.deepEqual(data(response), { error: 'PAYLOAD_TOO_LARGE', code: 'PAYLOAD_TOO_LARGE' });
  };
  for (const chunked of [false, true]) {
    const b = JSON.stringify(batch({ seq: chunked ? 1 : 0 }));
    const exact = await send(server, '/api/telemetry', { body: b + ' '.repeat(cap - Buffer.byteLength(b)), chunked });
    assert.equal(exact.status, 200, `exactly ${cap} bytes, chunked=${chunked}`);
    assert.deepEqual(data(exact), { ok: true });
  }
  // Fixed-length is rejected from the headers alone; never send the declared body.
  for (const size of [cap + 1, 400000]) {
    const r = await send(server, '/api/telemetry', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': size } });
    assert413(r, `declared Content-Length=${size}`);
  }
  const chunkedOver = await sendChunkedOverCap(server);
  assert.equal(chunkedOver.sent, cap + 1, 'chunked transfer must stop after CAP+1 payload bytes');
  assert413(chunkedOver, `chunked body=${cap + 1}`);
  assert.equal((await send(server, '/health/ready')).status, 200, 'server must stay ready after 413');
  const initial = counts(db);
  await new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path: '/api/telemetry', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 1000 } });
    req.on('error', () => {}); req.on('close', resolve); req.write('{'); req.once('socket', socket => socket.once('connect', () => setImmediate(() => req.destroy())));
  });
  assert.equal((await send(server, '/api/summary')).status, 200); assert.deepEqual(counts(db), initial);
  for (const [path, options, code] of [
    ['/api/telemetry', { body: '{' }, 400], ['/api/telemetry', { body: batch(), headers: { 'Content-Type': 'text/plain' } }, 415],
    ['/api/telemetry', { body: batch(), headers: { 'Content-Encoding': 'gzip' } }, 415], ['/api/telemetry', {}, 405],
    ['/api/summary', { method: 'POST' }, 405], ['/api/sessions', { method: 'PUT' }, 405], ['/api/missing', {}, 404], ['/api/sessions/missing00', {}, 404]
  ]) { const r = await send(server, path, options); assert.equal(r.status, code); if (code === 405) assert(r.headers.allow); }
  for (const limit of ['0', '-1', '201', 'NaN', 'Infinity', '1.5', '', '9007199254740992']) assert.equal((await send(server, `/api/sessions?limit=${limit}`)).status, 400, limit);
});

test('strict all-or-nothing validation, JSON roundtrip, multi-byte strings', async t => {
  const { server, db } = await fixture(t);
  const bad = [null, [], 'x', batch({ id: 123 }), batch({ seq: -1 }), batch({ seq: 1.1 }), batch({ seq: 2 ** 53 }), batch({ startedAt: '1' }), batch({ backend: 'gpu' }), batch({ context: [] }), batch({ context: { ua: 'x'.repeat(513) } }), batch({ context: { mobile: 1 } }), batch({ context: { extra: 1 } }), batch({ milestones: { enter: -1 } }), batch({ final: { duration: 0, stats: [] } }), batch({ final: { duration: 0, stats: { fps: -1 } } }), batch({ events: [{ t: 1, type: 'error', data: { msg: 'x'.repeat(301) } }] }), batch({ events: [{ t: 1, type: 'bad' }] }), batch({ samples: [sample(1), { ...sample(2), fps: '60' }] }), batch({ samples: [sample(1), { ...sample(2), phase: 'bad' }] }), batch({ samples: Array(2001).fill(sample(1)) }), batch({ events: Array(501).fill({ t: 1, type: 'paint' }) }), batch({ final: { duration: 1, stats: { loadTimes: { constructor: 1 } } } })];
  for (const b of bad) { assert.equal((await send(server, '/api/telemetry', { body: b })).status, 400, JSON.stringify(b).slice(0, 120)); assert.deepEqual(counts(db), [0, 0, 0, 0]); }
  assert.equal((await send(server, '/api/telemetry', { body: JSON.stringify(batch()).replace('"seq":0', '"seq":1e999') })).status, 400);
  const invalidUTF8 = Buffer.concat([Buffer.from(JSON.stringify(batch({ context: { ua: 'MARKER' } })).split('MARKER')[0]), Buffer.from([0xff]), Buffer.from(JSON.stringify(batch({ context: { ua: 'MARKER' } })).split('MARKER')[1])]);
  assert.equal((await send(server, '/api/telemetry', { body: invalidUTF8 })).status, 400);
  const b = batch({ context: { ua: '測試 '.repeat(100), mobile: false }, samples: [sample(1, null)], events: [{ t: 1, type: 'error', data: { msg: '字'.repeat(300) } }] });
  assert.equal((await send(server, '/api/telemetry', { body: b })).status, 200);
  const s = data(await send(server, `/api/sessions/${b.id}`)); assert.deepEqual(s.context, b.context); assert.deepEqual(s.events[0].data, b.events[0].data); assert.equal(s.samples[0].fps, null);
  for (const [table, cols] of [['sessions', ['context', 'milestones', 'final']], ['events', ['data']]]) for (const c of cols) assert.equal(db.prepare(`SELECT count(*) n FROM ${table} WHERE ${c} IS NOT NULL AND NOT json_valid(${c})`).get().n, 0);
});

test('ordering, immutable identity, dedupe after restart and transactional receipt rollback', async t => {
  const { server, db, root, dbPath } = await fixture(t);
  const high = batch({ seq: 2, samples: [sample(2)], final: { duration: 500, stats: { loadTimes: { senna: 42 }, loaded: 16 } } });
  assert.equal((await send(server, '/api/telemetry', { body: high })).status, 200);
  for (const seq of [0, 1]) assert.equal((await send(server, '/api/telemetry', { body: batch({ seq, context: { mobile: true }, milestones: { firstCar: 999, firstFrame: 50 }, samples: [sample(seq)], final: { duration: 10, stats: null } }) })).status, 200);
  let s = data(await send(server, `/api/sessions/${high.id}`));
  assert.equal(s.last_seq, 2); assert.equal(s.milestones.firstCar, 100); assert.equal(s.milestones.firstFrame, 50); assert.equal(s.context.mobile, true); assert.equal(s.final.duration, 500); assert.equal(s.final.stats.loadTimes.senna, 42);
  const snapshot = s;
  assert.equal((await send(server, '/api/telemetry', { body: batch({ seq: 2, startedAt: 999, samples: [sample(99)] }) })).status, 200);
  assert.deepEqual(data(await send(server, `/api/sessions/${high.id}`)), snapshot);
  for (const [change, code] of [[{ startedAt: START + 1 }, 'SESSION_IDENTITY_MISMATCH'], [{ context: { mobile: false } }, 'SESSION_CONTEXT_MISMATCH']]) {
    const r = await send(server, '/api/telemetry', { body: batch({ seq: 3, ...change }) }); assert.equal(r.status, 400); assert.equal(data(r).code, code);
  }
  assert.equal((await send(server, '/api/telemetry', { body: batch({ seq: 3, final: { duration: 600, stats: null } }) })).status, 200);
  s = data(await send(server, `/api/sessions/${high.id}`)); assert.equal(s.final.stats.loadTimes.senna, 42);
  db.exec("CREATE TRIGGER fail_sample BEFORE INSERT ON samples WHEN NEW.t=999 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  const initial = counts(db); assert.equal((await send(server, '/api/telemetry', { body: batch({ seq: 4, samples: [sample(999)] }) })).status, 500); assert.deepEqual(counts(db), initial);
  db.exec('DROP TRIGGER fail_sample'); assert.equal((await send(server, '/api/telemetry', { body: batch({ seq: 4, samples: [sample(999)] }) })).status, 200);
  await new Promise(r => server.close(r));
  const restarted = await createOpsServer({ root, dbPath }); restarted.listen(0, '127.0.0.1'); await once(restarted, 'listening');
  try { const before = counts(db); assert.equal((await send(restarted, '/api/telemetry', { body: batch({ seq: 4 }) })).status, 200); assert.deepEqual(counts(db), before); } finally { await new Promise(r => restarted.close(r)); }
});

test('legacy migration backs up every row and is idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'velance-migrate-')); const dbPath = join(root, 'legacy.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER, received_at INTEGER, context TEXT, milestones TEXT, backend TEXT, mobile INTEGER, final TEXT);
    CREATE TABLE samples (session_id TEXT, t INTEGER, phase TEXT, fps REAL, render_avg REAL, render_p95 REAL, draw_calls INTEGER, triangles INTEGER, loaded INTEGER, heap_mb REAL, pixel_ratio REAL, PRIMARY KEY(session_id,t));
    CREATE TABLE events (session_id TEXT, t INTEGER, type TEXT, data TEXT, PRIMARY KEY(session_id,t,type));
    INSERT INTO sessions VALUES ('legacy-0000',1,2,'{}','{}','webgpu',0,NULL);
    INSERT INTO samples VALUES ('legacy-0000',1,'browse',60,1,2,3,4,16,NULL,1);
    INSERT INTO events VALUES ('legacy-0000',1,'paint','{"i":1}');`);
  const before = ['sessions', 'samples', 'events'].map(t => db.prepare(`SELECT * FROM ${t}`).all()); db.close();
  try {
    for (let i = 0; i < 2; i++) {
      const server = await createOpsServer({ root, dbPath }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const source = new DatabaseSync(i === 0 ? server.backupPath : dbPath, { readOnly: true });
      for (const [j, table] of ['sessions', 'samples', 'events'].entries()) {
        const rows = source.prepare(`SELECT * FROM ${table}`).all().map(r => { delete r.last_seq; return r; }); assert.deepEqual(rows, before[j]);
      }
      source.close(); if (i === 1) assert.equal(server.backupPath, null);
      await new Promise(r => server.close(r));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('summary percentiles exclude unknown values and preserve partial/fallback semantics', async t => {
  const { server } = await fixture(t);
  assert.equal(data(await send(server, '/api/summary')).load.firstCar.p50, null);
  for (let i = 0; i < 4; i++) {
    const b = batch({ id: `summary-${i}`, context: { mobile: i === 0 }, milestones: { firstCar: [10, 20, 30, null][i], allLoaded: i === 0 ? 40 : null }, backend: i === 3 ? 'images' : 'webgpu', samples: [sample(1, i === 3 ? null : 30 + i * 10)], events: i === 3 ? [{ t: 1, type: 'engineError' }] : [] });
    assert.equal((await send(server, '/api/telemetry', { body: b })).status, 200);
  }
  const s = data(await send(server, `/api/summary?from=${START - 1}&to=${START + 1}`));
  assert.deepEqual(s.window.from, START - 1); assert.equal(s.window.to, START + 1);
  assert.equal(s.sessions, 4); assert.deepEqual(s.backends, { webgpu: 3, images: 1 }); assert.equal(s.errors, 1); assert.equal(s.mobile, 1); assert.equal(s.desktop, 3);
  assert.deepEqual(s.load.firstCar, { p50: 20, p95: 30, n: 3 }); assert.deepEqual(s.load.allLoaded, { p50: 40, p95: 40, n: 1 }); assert.equal(s.phases[0].n, 4); assert.equal(s.phases[0].fpsN, 3); assert.equal(s.phases[0].fpsP50, 40); assert.equal(s.phases[0].fpsP95, 50); assert.equal(s.trend[3].allLoaded, null);
});

test('summary windows reject malformed bounds, exclude upper edge and cache exact windows', async t => {
  const { server } = await fixture(t);
  for (const [id, startedAt] of [['window-0001', START - 1000], ['window-0002', START], ['window-0003', START + 1000]]) {
    assert.equal((await send(server, '/api/telemetry', { body: batch({ id, startedAt }) })).status, 200);
  }
  for (const params of ['hours=2', 'hours=', 'from=1', 'to=2', 'from=-1&to=2', 'from=1.5&to=2', 'from=1&to=1',
    'from=1&to=2678400002', 'from=0&to=9007199254740992', 'from=1&to=2&hours=24']) {
    const r = await send(server, `/api/summary?${params}`);
    assert.equal(r.status, 400, params); assert.equal(data(r).code, 'BAD_WINDOW');
  }
  for (const hours of ['1', '6', '24']) {
    const r = data(await send(server, `/api/summary?hours=${hours}`));
    assert.equal(r.sessions, 3); assert.equal(r.window.cohort, 'session-start');
    assert.equal(r.window.to - r.window.from, Number(hours) * 3600000);
  }
  const path = `/api/summary?from=${START}&to=${START + 1000}`;
  const first = data(await send(server, path)), cached = data(await send(server, path));
  assert.equal(first.sessions, 1); assert.equal(first.trend[0].startedAt, START);
  assert.deepEqual(cached, first, 'same exact window must reuse the cached snapshot');
  const text = (await send(server, '/metrics')).text;
  assert.match(text, /velance_summary_cache_total\{result="hit"\} [1-9]\d*/);
});

test('session and detail cursors are stable, bounded and reject malformed cursors', async t => {
  const { server, db } = await fixture(t);
  for (let i = 0; i < 5; i++) {
    assert.equal((await send(server, '/api/telemetry', { body: batch({ id: `cursor-${i.toString().padStart(4, '0')}` }) })).status, 200);
  }
  const expected = db.prepare('SELECT id FROM sessions ORDER BY received_at DESC,id DESC').all().map(row => row.id);
  const actual = [];
  let cursor = null;
  for (let page = 0; page < 3; page++) {
    const r = await send(server, `/api/sessions?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(r.status, 200);
    actual.push(...data(r).map(row => row.id));
    cursor = r.headers['x-next-cursor'] || null;
    assert.equal(Boolean(cursor), page < 2);
  }
  assert.deepEqual(actual, expected);
  assert.equal((await send(server, '/api/sessions?limit=200')).status, 200);
  for (const bad of ['%', 'notbase64', Buffer.from('{}').toString('base64url'), Buffer.from('[1]').toString('base64url'),
    Buffer.from('[1,12]').toString('base64url'), Buffer.from('[-1,"cursor-0000"]').toString('base64url')]) {
    const r = await send(server, `/api/sessions?cursor=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, bad); assert.equal(data(r).code, 'BAD_CURSOR');
  }
  const id = expected[0];
  db.exec('BEGIN IMMEDIATE');
  try {
    const insertSample = db.prepare('INSERT INTO samples(session_id,t,phase,fps) VALUES(?,?,?,?)');
    const insertEvent = db.prepare('INSERT INTO events(session_id,t,type,data) VALUES(?,?,?,?)');
    for (let t = 0; t < 2005; t++) insertSample.run(id, t, 'browse', 60);
    for (let t = 0; t < 505; t++) insertEvent.run(id, t, 'paint', '{"i":1}');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const first = data(await send(server, `/api/sessions/${id}`));
  assert.equal(first.samples.length, 2000); assert.equal(first.events.length, 500);
  assert.equal(first.page.samples.total, 2005); assert.equal(first.page.events.total, 505);
  assert(first.page.samples.next && first.page.events.next);
  const second = data(await send(server, `/api/sessions/${id}?samples=${first.page.samples.next}&events=${first.page.events.next}`));
  assert.deepEqual(second.samples.map(s => s.t), [0, 1, 2, 3, 4]);
  assert.deepEqual(second.events.map(e => e.t), [0, 1, 2, 3, 4]);
  assert.equal(second.page.samples.next, null); assert.equal(second.page.events.next, null);
  assert.equal(new Set([...first.samples, ...second.samples].map(s => s.t)).size, 2005);
  assert.equal(new Set([...first.events, ...second.events].map(e => e.t)).size, 505);
  for (const params of ['samples=bad', 'events=bad', `samples=${Buffer.from('[1,2]').toString('base64url')}`,
    `events=${Buffer.from('[1]').toString('base64url')}`]) {
    const r = await send(server, `/api/sessions/${id}?${params}`);
    assert.equal(r.status, 400, params); assert.equal(data(r).code, 'BAD_CURSOR');
  }
});

test('admission rejects bursts without losing accepted receipts or capacity', async t => {
  const { server, db } = await fixture(t);
  const results = [];
  for (let i = 0; i < 180; i++) results.push(await send(server, '/api/telemetry', { body: batch({ id: 'admit-0001' }) }));
  const accepted = results.filter(r => r.status === 200), rejected = results.filter(r => r.status === 429);
  assert(accepted.length > 0);
  assert(rejected.length > 0, 'a burst beyond the token bucket must reject some requests');
  for (const r of rejected) { assert.equal(r.headers['retry-after'], '1'); assert(['RATE_LIMIT', 'DB_QUEUE_FULL'].includes(data(r).code)); }
  assert(results.every(r => [200, 429].includes(r.status)));
  assert.deepEqual(counts(db), [1, 0, 0, 1], 'duplicate accepted deliveries remain idempotent');
  assert.equal(server.runtime.uploadBytes, 0, 'all upload reservations are released');
  assert.match((await send(server, '/metrics')).text, /velance_http_rejections_total\{class="overload",code="(?:RATE_LIMIT|DB_QUEUE_FULL)"\} [1-9]\d*/);
});

test('health, metrics, request logs and worker failure retain expected contracts', async t => {
  const logs = [];
  const { server } = await fixture(t, false, { log: (level, event, fields) => logs.push({ level, event, fields }) });
  assert.deepEqual(data(await send(server, '/health/live')), { status: 'live' });
  assert.deepEqual(data(await send(server, '/health/ready')), { status: 'ready' });
  const good = await send(server, '/api/telemetry', { body: batch() });
  assert.equal(good.status, 200); assert.match(good.headers['x-request-id'], /^[0-9a-f-]{36}$/i);
  const denied = await send(server, '/api/missing?token=SECRET_REQUEST_VALUE');
  assert.equal(denied.status, 404);
  const metricResponse = await send(server, '/metrics');
  assert.equal(metricResponse.status, 200); assert.match(metricResponse.headers['content-type'], /^text\/plain; version=0\.0\.4/);
  assert.match(metricResponse.text, /velance_ready 1/);
  assert.match(metricResponse.text, /velance_db_worker_up\{role="writer"\} 1/);
  assert.match(metricResponse.text, /velance_ingest_batches_total\{result="committed"\} 1/);
  assert.match(metricResponse.text, /velance_http_requests_total\{method="GET",route="\/api\/other",status="404"\} 1/);
  assert(logs.some(entry => entry.event === 'request' && entry.fields?.status === '404'));
  assert(!JSON.stringify(logs).includes('SECRET_REQUEST_VALUE'), 'query strings must not enter structured request logs');
  await server.runtime.database.reader.terminate();
  assert.equal(server.runtime.ready, false);
  assert.deepEqual(data(await send(server, '/health/live')), { status: 'live' });
  const unavailable = await send(server, '/health/ready');
  assert.equal(unavailable.status, 503); assert.deepEqual(data(unavailable), { status: 'unavailable' });
  assert.equal((await send(server, '/api/summary')).status, 503);
  assert.equal((await send(server, '/api/telemetry', { body: batch({ seq: 1 }) })).status, 503);
  assert.match((await send(server, '/metrics')).text, /velance_db_worker_up\{role="reader"\} 0/);
  const closing = server.shutdown();
  assert.strictEqual(server.shutdown(), closing, 'repeated shutdown joins the same close operation');
  await closing;
  assert.equal(server.listening, false); assert.equal(server.runtime.forced, false);
  assert(logs.some(entry => entry.event === 'shutdown_complete'));
});

test('writer failure denies further ingestion and retains committed data', async t => {
  const { server, db } = await fixture(t);
  assert.equal((await send(server, '/api/telemetry', { body: batch() })).status, 200);
  const saved = counts(db);
  await server.runtime.database.writer.terminate();
  assert.equal((await send(server, '/health/ready')).status, 503);
  const denied = await send(server, '/api/telemetry', { body: batch({ seq: 1 }) });
  assert.equal(denied.status, 503); assert.equal(data(denied).code, 'DB_UNAVAILABLE');
  assert.deepEqual(counts(db), saved);
  assert.equal(server.runtime.uploadBytes, 0);
  assert.match((await send(server, '/metrics')).text, /velance_db_worker_up\{role="writer"\} 0/);
});
