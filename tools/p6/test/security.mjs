import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createDeliveryServer } from '../../delivery/server.mjs';
import { createSnapshot, activateRelease } from '../../delivery/release.mjs';
import { validateStagingContract, validateStagingFile, STAGING_CONTRACT } from '../staging.mjs';

function send(server, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const buffer = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = request({ hostname: '127.0.0.1', port: server.address().port, method, path,
      headers: { ...(buffer ? { 'Content-Type': 'application/json', 'Content-Length': buffer.length } : {}), ...headers }, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks), complete: res.complete }));
    });
    req.once('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('staging fixture timeout')));
    req.end(buffer);
  });
}

async function fixture(t, upstream = null) {
  const temp = mkdtempSync(join(tmpdir(), 'velance-p6-private-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const sourceRoot = join(temp, 'owned-fixture'), storeDir = join(temp, 'private-store');
  for (const [file, bytes] of Object.entries({
    'index.html': '<!doctype html><title>Owned P6 fixture</title>',
    'src/app.js': 'export const fixture = true;',
    'assets/models/owned.glb': 'synthetic-data-not-a-valid-glb',
    'assets/images/owned/pic.webp': 'synthetic-image-bytes',
    '.env': 'DO_NOT_EXPOSE=1', '.git/config': 'private',
    'tools/ops/telemetry.db': 'PRIVATE_DB',
    'tools/ops/telemetry.db-wal': 'PRIVATE_WAL',
    'tools/ops/telemetry.db-shm': 'PRIVATE_SHM',
    'ops/index.html': 'PRIVATE_OPS',
    'tools/ops/backups/velance.db': 'PRIVATE_BACKUP'
  })) {
    const path = join(sourceRoot, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
  }
  const release = await createSnapshot({ sourceRoot, storeDir });
  await activateRelease({ storeDir, id: release.id });
  const server = createDeliveryServer({ storeDir, upstream });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { if (server.listening) await server.shutdown(); });
  return { server, release };
}

test('private staging policy is fail-closed, mutations to critical gates rejected', () => {
  const file = new URL('../../../config/p6/private-staging.json', import.meta.url);
  assert.deepEqual(validateStagingFile(file), STAGING_CONTRACT);
});

test('critical private staging mutations never pass policy gate', () => {
  const file = new URL('../../../config/p6/private-staging.json', import.meta.url);
  const config = validateStagingFile(file);
  assert.deepEqual(config, STAGING_CONTRACT);
  for (const [section, field, value] of [
    ['origin', 'publicRead', true], ['origin', 'publicList', true],
    ['edge', 'httpsRequired', false], ['edge', 'originAuthRequired', false],
    ['edge', 'denyByDefault', false], ['privateServices', 'bind', '0.0.0.0'],
    ['privateServices', 'offHostEncryptedBackupRequired', false]
  ]) {
    const bad = structuredClone(config); bad[section][field] = value;
    assert.throws(() => validateStagingContract(bad), undefined, `${section}.${field}`);
  }
  const bad = structuredClone(config); bad.edge.telemetry.enabled = true;
  assert.throws(() => validateStagingContract(bad));
  bad.edge.telemetry.enabled = false; bad.deployEnabled = true;
  assert.throws(() => validateStagingContract(bad));
});

test('release public path and negative matrix denies sensitive routes, aliases and traversal', async t => {
  const { server, release } = await fixture(t);
  const path = `/r/${release.id}/index.html`;
  const landing = await send(server, '/');
  assert.equal(landing.status, 307);
  assert.equal(landing.headers['cache-control'], 'no-store');
  assert.equal(landing.headers.location, path);
  const page = await send(server, path);
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /Owned P6 fixture/);
  assert.equal(page.headers['cache-control'], STAGING_CONTRACT.edge.immutableCache);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal((await send(server, path, { headers: { 'If-None-Match': page.headers.etag } })).status, 304);
  assert.equal((await send(server, path, { method: 'HEAD' })).body.length, 0);
  for (const location of [
    '/ops', '/ops/', '/ops/index.html', '/metrics', '/health/live', '/health/ready',
    '/api/summary', '/api/sessions', '/api/sessions/legitimate-session', '/api/telemetry/',
    '/api/telemetry?x=1', '/api/%74elemetry', '/api/telemetry%2f',
    '/tools/ops/telemetry.db', '/tools/ops/telemetry.db-wal', '/tools/ops/telemetry.db-shm',
    '/tools/ops/backups/velance.db', '/.git/config', '/.env',
    `/r/${release.id}/ops/index.html`, `/r/${release.id}/tools/ops/telemetry.db`,
    `/r/${release.id}/.env`, `/r/${release.id}/assets/models/other.glb`
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const result = await send(server, location, { method });
      assert.equal(result.status, 404, `${method} ${location}`);
    }
  }
  for (const location of [`/r/${release.id}/../index.html`, `/r/${release.id}/%2e%2e/index.html`,
    `/r/${release.id}/src%2f..%2findex.html`, `/r/${release.id}/%00`, '/%zz']) {
    assert.equal((await send(server, location)).status, 400, location);
  }
  for (const location of ['/', path]) {
    assert.equal((await send(server, location, { method: 'POST', body: '{}' })).status, 405, location);
  }
  assert.equal((await send(server, '/api/telemetry', { method: 'POST', body: '{}' })).status, 404);
});

test('telemetry remains optional, only exact local POST forwarded with non-sensitive headers', async t => {
  const received = [];
  const upstream = createHttpServer((req, res) => {
    const chunks = [];
    req.on('data', b => chunks.push(b));
    req.once('end', () => {
      received.push({ url: req.url, method: req.method, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(async () => { if (upstream.listening) await new Promise(r => upstream.close(r)); });
  const { server, release } = await fixture(t, `http://127.0.0.1:${upstream.address().port}`);
  const json = { id: 'synthetic-session-0000', seq: 0 };
  const good = await send(server, '/api/telemetry', { method: 'POST', body: json,
    headers: { Cookie: 'session=secret', Authorization: 'Bearer secret', 'X-Forwarded-For': '203.0.113.1' } });
  assert.equal(good.status, 200);
  assert.equal(good.headers['cache-control'], 'no-store');
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].url, '/api/telemetry');
  for (const sensitive of ['cookie', 'authorization', 'x-forwarded-for']) assert.equal(received[0].headers[sensitive], undefined);
  for (const location of ['/api/telemetry?x=1', '/api/telemetry/', '/api/%74elemetry']) {
    assert.equal((await send(server, location, { method: 'POST', body: json })).status, 404);
  }
  assert.equal((await send(server, '/api/telemetry')).status, 405);
  assert.equal((await send(server, '/api/telemetry', { method: 'POST', body: '{}',
    headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await send(server, '/api/telemetry', { method: 'POST', body: '{}',
    headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await send(server, '/api/telemetry', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'Content-Length': 262145 } })).status, 413);
  assert.equal(received.length, 1);
  assert.equal((await send(server, `/r/${release.id}/index.html`)).status, 200);
  await new Promise(r => upstream.close(r));
  const down = await send(server, '/api/telemetry', { method: 'POST', body: json });
  assert.equal(down.status, 503);
  assert.equal(JSON.parse(down.body.toString()).code, 'UPSTREAM_UNAVAILABLE');
  assert.equal((await send(server, `/r/${release.id}/index.html`)).status, 200);
});

test('no private upstream may be configured outside loopback', () => {
  for (const upstream of ['https://example.com:443', 'http://10.0.0.1:8090',
    'http://127.0.0.1:8090/ops', 'http://user:pass@127.0.0.1:8090']) {
    assert.throws(() => createDeliveryServer({ storeDir: '/tmp/p6-not-used', upstream }), { code: 'BAD_UPSTREAM' });
  }
});
