import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { request } from 'node:http';
import { createPaintFixtureServer } from '../gpu-ci.mjs';

test('paint GPU fixture serves only mapped bytes with CSP and no Ops access', async t => {
  const html = Buffer.from('<html><script type="importmap">{"imports":{}}</script></html>');
  const script = Buffer.from('export const test = true;');
  const demo = '/packages/tsl-carpaint/demo/';
  const server = createPaintFixtureServer(new Map([[demo + 'index.html', html], [demo + 'app.js', script]]));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = (path, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', b => chunks.push(b));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  const page = await send(demo + '?backend=webgl');
  assert.equal(page.status, 200);
  assert.deepEqual(page.bytes, html);
  assert.match(page.headers['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval' 'sha256-/);
  assert.equal(page.headers['x-velance-ops'], undefined);
  assert.deepEqual((await send(demo + 'app.js')).bytes, script);
  assert.equal((await send(demo, 'HEAD')).bytes.length, 0);
  for (const route of ['/', '/.git/HEAD', '/tools/ops/telemetry.db', '/ops/', '/api/telemetry',
    '/vendor/unmapped.js', demo + '../src/index.js', demo + '%61pp.js']) {
    assert.equal((await send(route)).status, 404, route);
  }
  assert.equal((await send('/api/telemetry', 'POST')).status, 405);
  assert.equal((await send(demo, 'GET', { Host: 'example.invalid' })).status, 403);
  assert.equal((await send(demo, 'GET', { Origin: 'https://example.invalid' })).status, 403);
});
