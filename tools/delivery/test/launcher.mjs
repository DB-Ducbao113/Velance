import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}` };
const privateRoutes = [
  '/.git/HEAD', '/docs/private.md', '/assets/models_original/source.glb',
  '/assets/models_original/', '/tools/ops/telemetry.db', '/tools/ops/telemetry.db-wal',
  '/tools/ops/telemetry.db-shm', '/tools/ops/telemetry.db.pre-v2.bak', '/.env',
  '/ops/', '/ops/index.html', '/packages/tsl-carpaint/demo/index.html',
  '/tools/render/render.html', '/api/summary', '/api/sessions', '/api/telemetry',
  '/manifest.json', '/assets/', '/src/', '/%2egit/HEAD', '/tools%2fops%2ftelemetry.db',
  '/%252egit/HEAD', '/assets/archive/car/.stage-a/private-640.webp'
];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'velance-launcher-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, data = 'SYNTHETIC_PRIVATE_ONLY') => {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data); return target;
  };
  for (const file of ['start.sh', 'start.bat', 'tools/p7/free-staging.mjs',
    'tools/delivery/server.mjs', 'tools/delivery/release.mjs', 'tools/delivery/static.mjs',
    'tools/delivery/security-headers.mjs']) {
    const target = join(root, file); mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(ROOT, file), target);
  }
  put('index.html', '<!doctype html><title>Launcher fixture</title>');
  put('src/app.js', 'export const fixture = true;');
  put('assets/models/gallery/car.glb', 'fixture gallery');
  put('assets/models/detail/car.glb', 'fixture detail');
  for (const route of privateRoutes.slice(0, 13).filter(route => !route.endsWith('/'))) put(route.slice(1));
  put('assets/archive/car/.stage-a/private-640.webp');
  return { root, put };
}

function command(args) {
  // CI runs the actual POSIX wrapper; Windows can verify the portable Node entrypoint.
  return process.platform === 'win32'
    ? [process.execPath, ['tools/p7/free-staging.mjs', '--mode', 'review', ...args]]
    : ['sh', ['start.sh', ...args]];
}

function send(port, path, method = 'HEAD', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP_TIMEOUT')));
    req.once('error', reject); req.end();
  });
}

test('actual launcher serves immutable visitor assets and denies private/alias/diagnostic routes', { timeout: 20000 }, async t => {
  const { root } = fixture(t);
  const [file, args] = command(['--port', '0']);
  const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`LAUNCH_TIMEOUT: ${output} ${stderr}`)), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); reject(new Error(`LAUNCH_EXIT ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /URL: (http:\/\/127\.0\.0\.1:\d+\/r\/[a-f0-9]{64}\/index\.html)/.exec(output);
      if (match) { clearTimeout(timer); resolve(new URL(match[1])); }
    });
  });
  const port = Number(url.port), prefix = url.pathname.replace(/\/index\.html$/, '');
  const redirect = await send(port, '/?diagnostics=1');
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.location, `${prefix}/index.html?diagnostics=1`);
  const landing = await send(port, url.pathname, 'GET');
  assert.equal(landing.status, 200);
  assert.match(landing.body.toString(), /Launcher fixture/);
  assert.equal(landing.headers['x-velance-ops'], undefined);
  assert.match(landing.headers['content-security-policy'], /(?:^|; )connect-src 'self' blob:(?:;|$)/);
  assert.equal(landing.headers['cache-control'], 'public, max-age=31536000, immutable');
  for (const tier of ['gallery', 'detail']) {
    const model = await send(port, `${prefix}/assets/models/${tier}/car.glb`);
    assert.equal(model.status, 200); assert.equal(model.headers['content-type'], 'model/gltf-binary');
  }
  for (const path of privateRoutes) {
    for (const route of [path, prefix + path]) {
      assert.equal((await send(port, route)).status, 404, route);
    }
  }
  assert.equal((await send(port, `${prefix}/%2e%2e/.env`)).status, 400);
  assert.equal((await send(port, '/api/telemetry', 'POST')).status, 404);
  assert.equal((await send(port, '/', 'HEAD', { Host: `evil.invalid:${port}` })).status, 400);
  assert.equal((await send(port, '/', 'HEAD', { Origin: 'https://evil.invalid' })).status, 403);
});

test('launcher fails before listening for non-loopback, backend, mode override, or symlink alias', t => {
  const { root } = fixture(t);
  function rejected(args, expected) {
    const [file, argv] = command(args);
    const out = spawnSync(file, argv, { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(out.error);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, expected);
    assert.doesNotMatch(out.stdout, /URL: http/i);
  }
  for (const args of [['--host', '0.0.0.0'], ['--upstream', 'http://127.0.0.1:8090'],
    ['--mode', 'smoke'], ['--db', 'tools/ops/telemetry.db']]) rejected(args, /USAGE/);
  try { symlinkSync(join(root, 'tools/ops/telemetry.db'), join(root, 'src/alias.js'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.diagnostic('Windows symlink privilege unavailable; alias case not exercised'); return;
    }
    throw error;
  }
  rejected(['--port', '0'], /SOURCE_SYMLINK/);
});
