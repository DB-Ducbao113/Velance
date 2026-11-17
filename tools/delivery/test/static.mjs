import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { publicPath, resolvePublicFile, serveStatic } from '../static.mjs';

const SCRIPT = 'export const version = "one";\n'.repeat(100);
const textOf = response => response.body.toString('utf8');
const decode = response => response.headers['content-encoding'] === 'br' ? brotliDecompressSync(response.body)
  : response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.body) : response.body;

function put(root, path, data) {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, data);
  return target;
}

async function fixture(t, { policy = 'mutable', opsHeader = false, verifyFile = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'velance-delivery-'));
  const dbPath = put(root, 'private/telemetry.db', Buffer.from('DB-PRIVATE-CONTENTS'));
  put(root, 'index.html', '<!doctype html><title>Mutable</title>');
  put(root, 'ops/index.html', '<!doctype html><title>Ops</title>');
  put(root, 'ops/ops.js', SCRIPT);
  put(root, 'ops/ops.css', 'body { color: black; }');
  put(root, 'src/app.js', SCRIPT);
  put(root, 'styles/main.css', 'body { color: red; }');
  put(root, 'vendor/lib.js', SCRIPT);
  put(root, 'vendor/basis.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  put(root, 'assets/models/car.glb', Buffer.alloc(1024 * 1024 + 5, 0x4a));
  put(root, 'assets/images/car/a.webp', Buffer.from([0x52, 0x49, 0x46, 0x46]));
  put(root, 'assets/environment/sky.webp', Buffer.from([0x52, 0x49, 0x46, 0x46]));
  put(root, 'packages/tsl-carpaint/demo/index.html', '<title>Demo</title>');
  put(root, 'packages/tsl-carpaint/demo/app.js', SCRIPT);
  put(root, 'packages/tsl-carpaint/src/index.js', SCRIPT);
  put(root, 'tools/render/render.html', '<title>Render</title>');
  put(root, '.env', 'SECRET');
  put(root, 'tools/private.js', 'SECRET');
  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      await serveStatic(req, res, { root, dbPath, path: decodeURIComponent(url.pathname), search: url.search, policy, opsHeader, verifyFile });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const body = Buffer.from(JSON.stringify({ code: error.code || 'INTERNAL' }));
      res.writeHead(error.status || 500, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      res.end(body);
    }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(async () => { await new Promise(resolve => http.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const send = (path = '/', { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: http.address().port, path, method, headers, agent: false }, res => {
      const parts = [];
      res.on('data', part => parts.push(part)); res.on('error', reject);
      res.on('end', () => {
        try { assert(res.complete, `incomplete ${path}`); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end();
  });
  return { root, dbPath, http, send };
}

test('allowlist preserves P2 mutable routes while excluding hidden, source maps and release-only paths', () => {
  for (const path of ['/', '/index.html', '/ops/', '/ops/index.html', '/ops/ops.js', '/ops/ops.css',
    '/src/app.js', '/styles/main.css', '/vendor/basis.wasm', '/vendor/lib.js',
    '/assets/models/car.glb', '/assets/images/car/a.webp', '/assets/environment/sky.webp',
    '/packages/tsl-carpaint/demo/', '/packages/tsl-carpaint/demo/app.js',
    '/packages/tsl-carpaint/src/index.js', '/tools/render/render.html']) {
    assert(publicPath(path), path);
  }
  for (const path of ['/.git/HEAD', '/.env', '/tools/private.js', '/tools/ops/telemetry.db', '/src/x.js.map',
    '/src/node_modules/x.js', '/src/.secret.js', '/src/../index.html', '/src/%2e%2e/app.js',
    '/src\\app.js', '//src/app.js', '/src//app.js', '/assets/models_original/a.glb',
    '/assets/images/car/a.png', '/ops/api.js', '/favicon.ico']) assert.equal(publicPath(path), false, path);
  assert.equal(publicPath('/assets/images/car/a.webp', { release: true }), true);
  assert.equal(publicPath('/assets/images/car/a.png'), false);
  for (const path of ['/ops/index.html', '/tools/render/render.html', '/.git/HEAD', '/tools/ops/server.mjs', '/src/app.js.map',
    '/assets/models_original/secret.glb', '/assets/models_prepared/a.glb', '/assets/images/car/a.png',
    '/assets/images/car/a.jpg', '/assets/images/car/a.avif', '/packages/tsl-carpaint/demo/app.js']) {
    assert.equal(publicPath(path, { release: true }), false, path);
  }
});

test('canonical resolver denies symlinks outside public trees and DB / sidecars even under public extensions', async t => {
  const { root, dbPath, send } = await fixture(t);
  symlinkSync(dbPath, join(root, 'src/alias.js'));
  symlinkSync('/etc/hosts', join(root, 'src/outside.js'));
  symlinkSync(join(root, 'tools/private.js'), join(root, 'src/inside.js'));
  put(root, 'private/telemetry.db-wal', 'WAL-SECRET');
  put(root, 'private/telemetry.db-shm', 'SHM-SECRET');
  put(root, 'private/telemetry.db.backup', 'BACKUP-SECRET');
  for (const [alias, target] of [['wal.js', 'private/telemetry.db-wal'], ['shm.js', 'private/telemetry.db-shm'],
    ['backup.js', 'private/telemetry.db.backup']]) symlinkSync(join(root, target), join(root, 'src', alias));
  for (const path of ['/src/alias.js', '/src/outside.js', '/src/inside.js', '/src/wal.js', '/src/shm.js', '/src/backup.js',
    '/.env', '/tools/private.js']) {
    assert.equal((await send(path)).status, 404, path);
    await assert.rejects(resolvePublicFile({ root, dbPath, path }), error => error.status === 404);
  }
  const allowed = await resolvePublicFile({ root, dbPath, path: '/src/app.js' });
  assert.equal(allowed.path, '/src/app.js'); assert.equal(allowed.mime, 'text/javascript; charset=utf-8');
  assert.equal(allowed.stat.isFile(), true);
  const first = await send('/src/app.js'); assert.equal(first.status, 200);
  unlinkSync(join(root, 'src/app.js'));
  symlinkSync(dbPath, join(root, 'src/app.js'));
  const denied = await send('/src/app.js', { headers: { 'If-None-Match': first.headers.etag } });
  assert.equal(denied.status, 404, 'previously cached alias must be revalidated before conditional 304');
});

test('mutable redirects, HEAD, MIME, ops header and cache policy', async t => {
  const { send } = await fixture(t, { opsHeader: true });
  for (const path of ['/ops', '/packages/tsl-carpaint/demo']) for (const method of ['GET', 'HEAD']) {
    const result = await send(`${path}?a=1`, { method });
    assert.equal(result.status, 308);
    assert.equal(result.headers.location, `${path}/?a=1`);
    assert.equal(result.body.length, 0);
  }
  for (const [path, type] of [['/', 'text/html'], ['/ops/', 'text/html'], ['/styles/main.css', 'text/css'],
    ['/src/app.js', 'text/javascript'], ['/vendor/basis.wasm', 'application/wasm'],
    ['/assets/models/car.glb', 'model/gltf-binary'], ['/assets/images/car/a.webp', 'image/webp']]) {
    const result = await send(path);
    assert.equal(result.status, 200, path);
    assert(result.headers['content-type'].startsWith(type));
    assert.equal(result.headers['cache-control'], 'no-cache');
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(result.headers['x-velance-ops'], ['/','/ops/'].includes(path) ? '1' : undefined);
    assert.equal(result.headers.vary, 'Accept-Encoding');
    assert.equal(result.headers['content-length'], String(result.body.length));
    assert.match(result.headers.etag, /^"[a-f0-9]{64}-identity"$/);
    const head = await send(path, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    assert.equal(head.headers.etag, result.headers.etag);
    assert.equal(head.headers['content-length'], String(result.body.length));
  }
  const denied = await send('/src/app.js', { method: 'POST' });
  assert.equal(denied.status, 405); assert.equal(denied.headers.allow, 'GET, HEAD');
});

test('negotiation honors q=0, wildcard, explicit identity and refuses impossible representations', async t => {
  const { send } = await fixture(t);
  for (const [header, expected] of [
    ['br, gzip', 'br'], ['gzip, br;q=0', 'gzip'],
    ['identity;q=0, br;q=1, gzip;q=0', 'br'],
    ['gzip;q=0.8, br;q=0.9, identity;q=0', 'br'],
    ['br;q=0.5, gzip;q=0.5, identity;q=1', 'identity'],
    ['*;q=0.8, identity;q=0', 'br'],
    ['gzip;q=0, br;q=0', 'identity']
  ]) {
    const result = await send('/src/app.js', { headers: { 'Accept-Encoding': header } });
    assert.equal(result.status, 200, header);
    assert.equal(result.headers['content-encoding'] ?? 'identity', expected, header);
    assert.equal(decode(result).toString(), SCRIPT);
    assert.equal(result.headers['content-length'], String(result.body.length));
  }
  for (const header of ['identity;q=0,br;q=0,gzip;q=0', '*;q=0']) {
    const res = await send('/src/app.js', { headers: { 'Accept-Encoding': header } });
    assert.equal(res.status, 406, header); assert.equal(JSON.parse(textOf(res)).code, 'NOT_ACCEPTABLE');
    assert.equal(res.headers.vary, 'Accept-Encoding');
  }
  const wasm = await send('/vendor/basis.wasm', { headers: { 'Accept-Encoding': 'gzip, br' } });
  assert.equal(wasm.status, 200); assert.equal(wasm.headers['content-encoding'], undefined);
  assert.deepEqual(wasm.body, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const incompatible = await send('/vendor/basis.wasm', { headers: { 'Accept-Encoding': 'gzip, identity;q=0' } });
  assert.equal(incompatible.status, 406);
});

test('ETags are representation-specific; weak, list and star If-None-Match yield correct 304 GET/HEAD', async t => {
  const { send } = await fixture(t);
  const identity = await send('/src/app.js');
  const gzip = await send('/src/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
  const br = await send('/src/app.js', { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(identity.status, 200); assert.equal(gzip.status, 200); assert.equal(br.status, 200);
  assert.notEqual(identity.headers.etag, gzip.headers.etag);
  assert.notEqual(br.headers.etag, gzip.headers.etag);
  assert.notEqual(identity.headers.etag, br.headers.etag);
  for (const [method, header] of [['GET', identity.headers.etag], ['HEAD', `W/${identity.headers.etag}`],
    ['GET', `"other", W/${identity.headers.etag}, "another"`], ['HEAD', '*']]) {
    const res = await send('/src/app.js', { method, headers: { 'If-None-Match': header } });
    assert.equal(res.status, 304); assert.equal(res.body.length, 0); assert.equal(res.headers.etag, identity.headers.etag);
    assert.equal(res.headers.vary, 'Accept-Encoding'); assert.equal(res.headers['content-length'], undefined);
  }
  const mismatch = await send('/src/app.js', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': identity.headers.etag } });
  assert.equal(mismatch.status, 200);
  const compressed304 = await send('/src/app.js', { method: 'HEAD', headers: {
    'Accept-Encoding': 'gzip', 'If-None-Match': `W/${gzip.headers.etag}` } });
  assert.equal(compressed304.status, 304); assert.equal(compressed304.headers.etag, gzip.headers.etag);
  assert.equal(compressed304.headers['content-encoding'], 'gzip');
  const head = await send('/src/app.js', { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(head.headers.etag, br.headers.etag);
  assert.equal(head.headers['content-length'], String(br.body.length));
});

test('same-size edits and atomic replacements invalidate representations and ETags', async t => {
  const { root, send } = await fixture(t);
  const path = '/src/app.js';
  const first = await send(path, { headers: { 'Accept-Encoding': 'br' } });
  const changed = SCRIPT.replaceAll('one', 'two');
  assert.equal(changed.length, SCRIPT.length);
  writeFileSync(join(root, 'src/app.js'), changed);
  const second = await send(path, { headers: { 'Accept-Encoding': 'br', 'If-None-Match': first.headers.etag } });
  assert.equal(second.status, 200, 'same-size in-place change must not be 304');
  assert.notEqual(second.headers.etag, first.headers.etag);
  assert.equal(decode(second).toString(), changed);
  const replacement = changed.replaceAll('two', 'tri');
  put(root, 'src/new-app.js', replacement);
  renameSync(join(root, 'src/new-app.js'), join(root, 'src/app.js'));
  const third = await send(path, { headers: { 'Accept-Encoding': 'br', 'If-None-Match': second.headers.etag } });
  assert.equal(third.status, 200, 'atomic replacement must not reuse stale compressed response');
  assert.notEqual(third.headers.etag, second.headers.etag);
  assert.equal(decode(third).toString(), replacement);
  assert.equal(third.headers['content-length'], String(third.body.length));
});

test('immutable policy validates content before 304/body, keeps opsHeader opt-in, and serves binary identity', async t => {
  let validHash = createHash('sha256').update(SCRIPT).digest('hex');
  let called = 0;
  const verifyFile = async ({ file, path, sha256, bytes }) => {
    called++;
    assert(file.endsWith('src/app.js') || path !== '/src/app.js');
    if (path === '/src/app.js' && sha256 !== validHash) throw Object.assign(new Error('RELEASE_MISMATCH'), { status: 503, code: 'RELEASE_MISMATCH' });
    assert(Number.isInteger(bytes));
  };
  const { send, root } = await fixture(t, { policy: 'immutable', verifyFile });
  const first = await send('/src/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(first.status, 200);
  assert.equal(first.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(first.headers['x-velance-ops'], undefined);
  const same = await send('/src/app.js', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': first.headers.etag } });
  assert.equal(same.status, 304); assert.equal(called >= 2, true, 'verifyFile must also run for conditional requests');
  writeFileSync(join(root, 'src/app.js'), SCRIPT.replaceAll('one', 'two'));
  const invalid = await send('/src/app.js', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': first.headers.etag } });
  assert.equal(invalid.status, 503); assert.equal(JSON.parse(textOf(invalid)).code, 'RELEASE_MISMATCH');
  validHash = createHash('sha256').update(SCRIPT.replaceAll('one', 'two')).digest('hex');
  const second = await send('/src/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(second.status, 200); assert.notEqual(second.headers.etag, first.headers.etag);
  const binary = await send('/assets/models/car.glb', { headers: { 'Accept-Encoding': 'br, gzip' } });
  assert.equal(binary.status, 200); assert.equal(binary.headers['content-encoding'], undefined);
  assert.equal(binary.body.length, 1024 * 1024 + 5);
  assert(binary.body.equals(Buffer.alloc(1024 * 1024 + 5, 0x4a)));
  assert.equal((await send('/ops/index.html')).status, 404);
  assert.equal((await send('/tools/render/render.html')).status, 404);
  assert.equal((await send('/ops')).status, 404);
});

test('compression jobs share a representation and repeated concurrent requests decode correctly', async t => {
  const { send } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 24 }, () => send('/src/app.js', { headers: { 'Accept-Encoding': 'br' } })));
  const etags = new Set(responses.map(r => r.headers.etag));
  assert.equal(etags.size, 1);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'br');
    assert.equal(response.headers['content-length'], String(response.body.length));
    assert.equal(decode(response).toString(), SCRIPT);
  }
});

test('compression bounds reject oversized inputs while allowing large identity streams', async t => {
  const { send, root } = await fixture(t);
  const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 65);
  put(root, 'src/huge.js', oversized);
  const compressed = await send('/src/huge.js', { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(compressed.status, 503);
  assert.equal(JSON.parse(textOf(compressed)).code, 'STATIC_BUSY');
  const identity = await send('/src/huge.js');
  assert.equal(identity.status, 200);
  assert.equal(identity.headers['content-encoding'], undefined);
  assert.equal(identity.headers['content-length'], String(oversized.length));
  assert(identity.body.equals(oversized));
});

test('aborted binary stream releases the request and the server continues serving valid files', async t => {
  const { http, root, send } = await fixture(t);
  put(root, 'assets/models/stream-abort.glb', Buffer.alloc(16 * 1024 * 1024, 0x47));
  const interrupted = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: http.address().port,
      path: '/assets/models/stream-abort.glb', agent: false }, res => {
      assert.equal(res.statusCode, 200);
      res.once('data', () => res.destroy());
      res.once('close', () => resolve(!res.complete));
      res.once('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    });
    req.on('error', reject);
    req.end();
  });
  assert(interrupted, 'test must close before receiving the full stream');
  const alive = await send('/src/app.js');
  assert.equal(alive.status, 200);
  assert.equal(decode(alive).toString(), SCRIPT);
});

test('40+ distinct concurrent JS encodings saturate bounded compression reservations without corrupting responses', async t => {
  const { send, root } = await fixture(t, {
    verifyFile: async () => { await new Promise(resolve => setTimeout(resolve, 250)); }
  });
  const names = Array.from({ length: 48 }, (_, i) => `load-${i}.js`);
  for (const name of names) put(root, `src/${name}`, `export const id = '${name}';\n${'// data \n'.repeat(3000)}`);
  const results = await Promise.all(names.map(name => send(`/src/${name}`, { headers: { 'Accept-Encoding': 'br' } })));
  const accepted = results.filter(r => r.status === 200);
  const rejected = results.filter(r => r.status === 503);
  assert(accepted.length > 0, 'some requests must pass the capacity gate');
  assert(rejected.length > 0, 'capacity must reject excessive distinct outstanding compression requests');
  assert(results.every(r => r.status === 200 || r.status === 503));
  for (const response of rejected) assert.equal(JSON.parse(textOf(response)).code, 'STATIC_BUSY');
  for (let i = 0; i < results.length; i++) if (results[i].status === 200) {
    assert.equal(results[i].headers['content-encoding'], 'br');
    assert.equal(results[i].headers['content-length'], String(results[i].body.length));
    assert.equal(decode(results[i]).toString(), `export const id = '${names[i]}';\n${'// data \n'.repeat(3000)}`);
  }
  const recovered = await send('/src/load-47.js', { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(recovered.status, 200, 'reservations must be released after the burst');
});
