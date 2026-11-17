#!/usr/bin/env node
// P7 free-only, LOCAL review. No cloud, credentials, payment method,
// telemetry upstream, public tunnelling, DNS or production deployment.
// Smoke mode uses synthetic authored fixtures, not unapproved car assets.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshot, activateRelease, verifySnapshot } from '../delivery/release.mjs';
import { createDeliveryServer } from '../delivery/server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const FREE_STAGING_POLICY = Object.freeze({
  costVnd: 0, networkBinding: '127.0.0.1', upstream: null,
  cloud: false, publicLaunchAuthorized: false, licensedAssetsForPublicUse: false
});

export function parseOptions(argv = []) {
  let mode = 'smoke', port = 0;
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!value || value.startsWith('--') || seen.has(key) || !['--mode', '--port'].includes(key))
      throw new Error('USAGE: node tools/p7/free-staging.mjs --mode smoke|review [--port 0..65535]');
    seen.add(key);
    if (key === '--mode') mode = value;
    else {
      if (!/^(0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > 65535)
        throw new Error('INVALID_PORT');
      port = Number(value);
    }
  }
  if (!['smoke', 'review'].includes(mode)) throw new Error('MODE_MUST_BE_SMOKE_OR_REVIEW');
  if (mode === 'smoke' && port !== 0) throw new Error('SMOKE_ONLY_RANDOM_PORT');
  return { mode, port };
}

function put(root, path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, { flag: 'wx', mode: 0o600 });
}
function syntheticSource(root) {
  put(root, 'index.html', '<!doctype html><html lang="en"><title>VELANCE FREE STAGING synthetic</title><p>fixture only, no real vehicles</p></html>');
  put(root, 'src/fixture.js', 'export const synthetic = true;\n');
  put(root, 'styles/main.css', 'body { background: #111; color: #eee; }\n');
  put(root, 'assets/models/fixture.glb', Buffer.from('fixture-only-invalid-glb-not-a-real-car'));
  put(root, 'assets/images/fixture/01-front-three-quarter.webp', Buffer.from('fixture-only-invalid-webp'));
  // Planted secrets: must never appear in the immutable release or HTTP.
  put(root, '.env', 'SECRET=never-distribute\n');
  put(root, 'tools/ops/telemetry.db', 'FAKE_PRIVATE_DB_DO_NOT_SERVE');
  put(root, 'ops/index.html', 'FAKE_PRIVATE_DASHBOARD');
  put(root, 'assets/models_original/source.glb', 'FAKE_ORIGINAL');
}
async function get(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: options.method || 'GET',
      headers: options.headers || {}, agent: false, timeout: 8000 }, res => {
      const chunks = [];
      res.on('data', data => chunks.push(data));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end();
  });
}

// Return a disposer for a private listener and temporary immutable snapshot.
// No persistent folder under the repository is used or modified.
export async function createFreeStaging({ mode = 'smoke', port = 0 } = {}) {
  assert(['smoke', 'review'].includes(mode));
  assert(Number.isSafeInteger(port) && port >= 0 && port <= 65535);
  assert(mode === 'review' || port === 0);
  const temp = mkdtempSync(join(tmpdir(), 'velance-free-staging-'));
  let server;
  try {
    const sourceRoot = mode === 'smoke' ? join(temp, 'synthetic-source') : ROOT;
    if (mode === 'smoke') syntheticSource(sourceRoot);
    const storeDir = join(temp, 'private-immutable-store');
    const snapshot = await createSnapshot({ sourceRoot, storeDir });
    await verifySnapshot({ storeDir, id: snapshot.id });
    await activateRelease({ storeDir, id: snapshot.id });
    server = createDeliveryServer({ storeDir, upstream: null });
    server.listen(port, FREE_STAGING_POLICY.networkBinding);
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/r/${snapshot.id}/index.html`;
    let disposed = false;
    return {
      server, snapshot, url,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        try { if (server.listening) await server.shutdown(); }
        finally { rmSync(temp, { recursive: true, force: true }); }
      }
    };
  } catch (error) {
    if (server?.listening) await server.shutdown();
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

export async function smokeFreeStaging() {
  const staging = await createFreeStaging({ mode: 'smoke' });
  try {
    const { snapshot, server } = staging;
    const port = server.address().port;
    assert.equal(server.address().address, '127.0.0.1', 'Never bind to LAN/WAN');
    const redirect = await get(port, '/');
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.location, `/r/${snapshot.id}/index.html`);
    assert.equal(redirect.headers['cache-control'], 'no-store');
    const landing = await get(port, redirect.headers.location);
    assert.equal(landing.status, 200);
    assert.match(landing.body, /FREE STAGING synthetic/);
    assert.equal(landing.headers['cache-control'], 'public, max-age=31536000, immutable');
    const etag = await get(port, redirect.headers.location, { headers: { 'If-None-Match': landing.headers.etag } });
    assert.equal(etag.status, 304);
    assert.equal((await get(port, redirect.headers.location, { method: 'HEAD' })).body, '');
    const denied = ['/ops/', '/api/summary', '/api/sessions', '/api/telemetry',
      '/tools/ops/telemetry.db', '/.env', '/assets/models_original/source.glb',
      `/r/${snapshot.id}/ops/index.html`, `/r/${snapshot.id}/.env`,
      `/r/${snapshot.id}/tools/ops/telemetry.db`];
    for (const path of denied) assert.equal((await get(port, path)).status, 404, path);
    assert.equal((await get(port, '/api/telemetry', { method: 'POST' })).status, 404);
    assert.equal((await get(port, '/', { headers: { Host: 'evil.example' } })).status, 400);
    assert.equal((await get(port, '/', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await get(port, `/r/${snapshot.id}/%2e%2e/.env`)).status, 400);
    assert(!snapshot.manifest.files.some(file => /(?:telemetry\.db|models_original|\.env|\/ops\/)/.test(file.path)));
    return {
      format: 'velance-p7-free-only-smoke/1', status: 'PASS_LOCAL', costVnd: 0,
      binding: server.address().address, syntheticOnly: true, providerCalls: 0,
      cloudResourcesCreated: 0, telemetryBackendEnabled: false,
      releaseId: snapshot.id, releaseFiles: snapshot.manifest.files.length,
      securityChecks: { immutable: true, etag304: true, privateRoutesDenied: denied.length,
        postTelemetryDenied: true, foreignHostDenied: true, foreignOriginDenied: true,
        traversalDenied: true }, publicLaunchAuthorized: false
    };
  } finally { await staging.dispose(); }
}

if (import.meta.main) {
  let staging;
  try {
    assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ required');
    const options = parseOptions(process.argv.slice(2));
    if (options.mode === 'smoke') {
      console.log(JSON.stringify(await smokeFreeStaging(), null, 2));
    } else {
      staging = await createFreeStaging(options);
      console.log('[VELANCE] FREE local review ONLY — no cloud/no telemetry/no legal approval.');
      console.log('[VELANCE] URL: ' + staging.url);
      console.log('[VELANCE] Press Ctrl+C to stop and delete temporary snapshot.');
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
        await staging.dispose(); process.exit(0);
      });
    }
  } catch (error) {
    if (staging) await staging.dispose();
    console.error('[VELANCE] FREE_STAGING_FAILED: ' + error.message);
    process.exitCode = 1;
  }
}
