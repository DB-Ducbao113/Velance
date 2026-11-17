import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request } from 'node:http';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createDeliveryServer } from '../server.mjs';
import { createSnapshot, activateRelease, rollbackRelease } from '../release.mjs';

function send(server, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      agent: false, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', part => chunks.push(part));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8'), complete: res.complete }));
    });
    req.once('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture HTTP deadline exceeded')));
    req.end(data);
  });
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'velance-delivery-preview-'));
  const sourceRoot = join(root, 'source'), storeDir = join(root, 'private-releases');
  mkdirSync(sourceRoot, { recursive: true });
  const put = (file, content = file) => {
    mkdirSync(join(sourceRoot, file, '..'), { recursive: true });
    writeFileSync(join(sourceRoot, file), content);
  };
  put('index.html', '<!doctype html><html><body>release A<script type="module" src="./src/app.js"></script></body></html>');
  put('src/app.js', 'export const revision = "A";');
  put('styles/main.css', 'body{background:black}');
  put('vendor/three/three.core.js', 'export const engine = 1;');
  put('assets/models/demo.glb', Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]));
  put('assets/images/car/01.webp', Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]));
  put('ops/index.html', '<html>SECRET OPS</html>');
  put('tools/render/render.html', 'PRIVATE RENDER');
  put('tools/ops/telemetry.db', 'PRIVATE DATABASE');
  put('.git/config', 'PRIVATE GIT');
  put('assets/models_original/secret.glb', 'PRIVATE MASTER');
  put('assets/images/car/01.png', 'PRIVATE PNG MASTER');
  const result = await createSnapshot({ sourceRoot, storeDir });
  await activateRelease({ storeDir, id: result.id });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, sourceRoot, storeDir, put, first: result };
}

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    if (!server.listening) return;
    if (typeof server.shutdown === 'function') await server.shutdown();
    else await new Promise(r => server.close(r));
  });
  return server;
}

test('immutable release routing, versioned cache, HEAD and private endpoint isolation', async t => {
  const f = await fixture(t);
  const preview = await listen(t, createDeliveryServer({ storeDir: f.storeDir }));
  const landing = await send(preview, '/?car=senna');
  assert.equal(landing.status, 307);
  assert.equal(landing.headers.location, `/r/${f.first.id}/index.html?car=senna`);
  assert.equal(landing.headers['cache-control'], 'no-store');
  const document = await send(preview, landing.headers.location);
  assert.equal(document.status, 200);
  assert.equal(document.complete, true);
  assert.match(document.text, /release A/);
  assert.match(document.headers['cache-control'], /immutable/);
  assert.equal(document.headers['x-velance-ops'], undefined, 'plain releases never activate telemetry');
  const head = await send(preview, landing.headers.location, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], document.headers['content-length']);
  const cached = await send(preview, landing.headers.location, { headers: { 'If-None-Match': document.headers.etag } });
  assert.equal(cached.status, 304); assert.equal(cached.body.length, 0);
  const model = await send(preview, `/r/${f.first.id}/assets/models/demo.glb`);
  assert.equal(model.status, 200);
  assert.deepEqual(model.body, Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]));
  assert.equal(model.headers['content-encoding'], undefined);

  for (const path of ['/ops/', '/ops/index.html', '/api/summary', '/api/sessions', '/metrics', '/health/ready',
    '/tools/ops/telemetry.db', '/tools/render/render.html', '/assets/models_original/secret.glb',
    `/r/${f.first.id}/ops/index.html`, `/r/${f.first.id}/tools/render/render.html`,
    `/r/${f.first.id}/assets/images/car/01.png`]) {
    const response = await send(preview, path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers['cache-control'], 'no-store', path);
  }
  for (const path of [`/r/${f.first.id}/%2e%2e/index.html`, `/r/${f.first.id}/src%2f..%2findex.html`,
    `/r/${f.first.id}/%00`]) {
    assert.equal((await send(preview, path)).status, 400, path);
  }
  assert.equal((await send(preview, '/api/telemetry', { method: 'POST', body: { ok: true } })).status, 404);
});

test('release activation and rollback preserve old loaded links without mixed version', async t => {
  const f = await fixture(t);
  const preview = await listen(t, createDeliveryServer({ storeDir: f.storeDir }));
  const oldUrl = `/r/${f.first.id}/index.html`;
  assert.match((await send(preview, oldUrl)).text, /release A/);
  f.put('index.html', '<!doctype html><html><body>release B</body></html>');
  f.put('src/app.js', 'export const revision = "B";');
  const second = await createSnapshot({ sourceRoot: f.sourceRoot, storeDir: f.storeDir });
  assert.notEqual(second.id, f.first.id);
  await activateRelease({ storeDir: f.storeDir, id: second.id });
  assert.equal((await send(preview, '/')).headers.location, `/r/${second.id}/index.html`);
  assert.match((await send(preview, oldUrl)).text, /release A/);
  assert.match((await send(preview, `/r/${second.id}/index.html`)).text, /release B/);
  assert.match((await send(preview, `/r/${f.first.id}/src/app.js`)).text, /revision = "A"/);
  assert.match((await send(preview, `/r/${second.id}/src/app.js`)).text, /revision = "B"/);
  await rollbackRelease({ storeDir: f.storeDir });
  assert.equal((await send(preview, '/')).headers.location, oldUrl);
  assert.match((await send(preview, `/r/${second.id}/index.html`)).text, /release B/);
  assert.match((await send(preview, oldUrl)).text, /release A/);
});

test('in-place same-size release modification is rejected before immutable response', async t => {
  const f = await fixture(t);
  const preview = await listen(t, createDeliveryServer({ storeDir: f.storeDir }));
  const fileUrl = `/r/${f.first.id}/src/app.js`;
  const before = await send(preview, fileUrl);
  assert.equal(before.status, 200);
  const file = join(f.first.root, 'src/app.js');
  const bytes = readFileSync(file, 'utf8').replace('"A"', '"Z"');
  assert.equal(Buffer.byteLength(bytes), before.body.length);
  chmodSync(file, 0o600); // Deliberately simulate tampering with a read-only snapshot.
  writeFileSync(file, bytes);
  const corrupted = await send(preview, fileUrl);
  assert.equal(corrupted.status, 503);
  assert.equal(JSON.parse(corrupted.text).code, 'RELEASE_MISMATCH');
  assert.equal(corrupted.headers['cache-control'], 'no-store');
});

test('telemetry proxy forwards only exact POST to a fixed loopback upstream and static survives upstream outage', async t => {
  const f = await fixture(t);
  const received = [];
  const upstream = createHttpServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8') });
      const body = JSON.stringify({ ok: true });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const port = upstream.address().port;
  t.after(async () => { if (upstream.listening) await new Promise(r => upstream.close(r)); });
  const preview = await listen(t, createDeliveryServer({ storeDir: f.storeDir, upstream: `http://127.0.0.1:${port}` }));
  const url = `/r/${f.first.id}/index.html`;
  assert.equal((await send(preview, url)).headers['x-velance-ops'], '1');
  assert.equal((await send(preview, `/r/${f.first.id}/src/app.js`)).headers['x-velance-ops'], undefined);
  const payload = { id: 'preview-session-0000', seq: 0 };
  const accepted = await send(preview, '/api/telemetry', { method: 'POST', body: payload,
    headers: { 'X-Forwarded-For': '203.0.113.99', Authorization: 'Bearer secret', Cookie: 'private=1' } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(JSON.parse(accepted.text), { ok: true });
  assert.equal(accepted.headers['cache-control'], 'no-store');
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/api/telemetry');
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].headers['x-forwarded-for'], undefined);
  assert.equal(received[0].headers.authorization, undefined);
  assert.equal(received[0].headers.cookie, undefined);
  assert.equal(received[0].headers.origin, `http://127.0.0.1:${port}`);
  assert.equal((await send(preview, '/api/summary')).status, 404);
  assert.equal((await send(preview, '/api/telemetry?forward=http://evil.invalid',
    { method: 'POST', body: payload })).status, 404);
  assert.equal((await send(preview, '/api/%74elemetry',
    { method: 'POST', body: payload })).status, 404);
  assert.equal((await send(preview, '/api/telemetry')).status, 405);
  const oversized = await send(preview, '/api/telemetry', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'Content-Length': 262145 } });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.complete, true);
  assert.equal(JSON.parse(oversized.text).code, 'PAYLOAD_TOO_LARGE');
  assert.equal(received.length, 1, 'headers-only oversized body must never reach the upstream');
  assert.equal((await send(preview, '/api/telemetry', { method: 'POST', body: '{}',
    headers: { Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await send(preview, '/api/telemetry', { method: 'POST', body: '{}',
    headers: { 'Content-Type': 'text/plain' } })).status, 415);
  await new Promise(r => upstream.close(r));
  const unavailable = await send(preview, '/api/telemetry', { method: 'POST', body: payload });
  assert.equal(unavailable.status, 503);
  assert.equal(JSON.parse(unavailable.text).code, 'UPSTREAM_UNAVAILABLE');
  assert.equal((await send(preview, url)).status, 200, 'static must remain healthy during private API outage');
});

test('preview upstream configuration accepts loopback only including bracketed IPv6', () => {
  const storeDir = '/tmp/velance-preview-config-untouched';
  for (const upstream of ['https://example.invalid:8090', 'http://example.invalid:8090',
    'http://127.0.0.1:8090/private', 'http://127.0.0.1:8090?target=evil',
    'http://user:pass@127.0.0.1:8090']) {
    assert.throws(() => createDeliveryServer({ storeDir, upstream }), { code: 'BAD_UPSTREAM' }, upstream);
  }
  for (const upstream of ['http://127.0.0.1:8090', 'http://localhost:8090', 'http://[::1]:8090']) {
    const preview = createDeliveryServer({ storeDir, upstream });
    assert.equal(preview.listening, false);
  }
});
