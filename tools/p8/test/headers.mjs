import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BASE_SECURITY_HEADERS, htmlCsp } from '../../delivery/security-headers.mjs';
import { createSnapshot, activateRelease } from '../../delivery/release.mjs';
import { createDeliveryServer } from '../../delivery/server.mjs';
import { createOpsServer } from '../../ops/server.mjs';

const script = '{"imports":{"three":"./vendor/three/three.webgpu.js"}}';
const fixtureHtml = `<!doctype html><title>P8 synthetic</title><script type="importmap">${script}</script><script type="module" src="./src/app.js"></script>`;
const expected = "'sha256-" + createHash('sha256').update(script).digest('base64') + "'";

test('CSP hashes only permitted import map, blocks arbitrary inline JS, and restricts browser capabilities', () => {
  const csp = htmlCsp(fixtureHtml);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert(csp.includes(expected));
  assert(csp.includes("frame-ancestors 'none'"));
  assert(csp.includes("object-src 'none'"));
  assert(csp.includes("connect-src 'self'"));
  assert(!csp.includes("'unsafe-eval'"));
  assert(!/script-src[^;]*'unsafe-inline'/.test(csp));
  assert(!csp.includes('https:;'));
  assert.equal(htmlCsp(readFileSync('index.html')).includes("script-src 'self'"), true);
  assert.throws(() => htmlCsp('<script>alert(1)</script>'), /UNAPPROVED_INLINE_SCRIPT/);
  assert.throws(() => htmlCsp('<script src="./src/app.js">alert(1)</script>'), /SCRIPT_TAG_HAS_INLINE_BODY/);
  assert.throws(() => htmlCsp(`<script type="importmap">${script}</script><script type="importmap">${script}</script>`), /UNAPPROVED_INLINE_SCRIPT/);
  assert.throws(() => htmlCsp({ toString() { return fixtureHtml; } }), /HTML_BUFFER_REQUIRED/);
});

function send(port, path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject); req.end();
  });
}
function assertHeaders(headers, { html = false } = {}) {
  for (const [key, expectedValue] of Object.entries(BASE_SECURITY_HEADERS))
    assert.equal(headers[key.toLowerCase()], expectedValue);
  if (html) {
    assert(headers['content-security-policy'].includes(expected));
    assert(!/script-src[^;]*'unsafe-inline'/.test(headers['content-security-policy']));
  }
}

test('immutable private delivery returns CSP on 200/HEAD/304 and baseline headers on 404', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'velance-p8-headers-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const sourceRoot = join(temp, 'source'), storeDir = join(temp, 'store');
  for (const [path, data] of [['index.html', fixtureHtml], ['src/app.js', 'export const ok=true;']]) {
    const file = join(sourceRoot, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data);
  }
  const release = await createSnapshot({ sourceRoot, storeDir });
  await activateRelease({ storeDir, id: release.id });
  const server = createDeliveryServer({ storeDir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { if (server.listening) await server.shutdown(); });
  const port = server.address().port, path = `/r/${release.id}/index.html`;
  for (const method of ['GET', 'HEAD']) {
    const response = await send(port, path, method);
    assert.equal(response.status, 200);
    assertHeaders(response.headers, { html: true });
    if (method === 'HEAD') assert.equal(response.body.length, 0);
  }
  const first = await send(port, path);
  const notModified = await send(port, path, 'GET', { 'If-None-Match': first.headers.etag });
  assert.equal(notModified.status, 304);
  assertHeaders(notModified.headers, { html: true });
  assertHeaders((await send(port, '/ops/')).headers);
  const redirect = await send(port, '/');
  assert.equal(redirect.status, 307); assertHeaders(redirect.headers);
});

test('Ops local HTTP defaults to anti-clickjacking/anti-referrer and CSP for HTML only', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'velance-p8-ops-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const path = join(temp, 'index.html');
  writeFileSync(path, fixtureHtml);
  const server = await createOpsServer({ root: temp, dbPath: join(temp, 'fixture.db') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await server.shutdown(); });
  for (const route of ['/', '/unknown']) {
    const response = await send(server.address().port, route);
    assertHeaders(response.headers, { html: route === '/' });
    assert.equal(response.status, route === '/' ? 200 : 404);
  }
});
