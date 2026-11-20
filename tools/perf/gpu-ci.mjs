// Manual private GPU runner: immutable showroom, isolated paint fixture, no Ops.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDeliveryServer } from '../delivery/server.mjs';
import { createSnapshot, activateRelease } from '../delivery/release.mjs';
import { applySecurityHeaders, htmlCsp } from '../delivery/security-headers.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const demo = '/packages/tsl-carpaint/demo/';
export function createPaintFixtureServer(files) {
  // Explicit byte map. Request URLs cannot select filesystem paths.
  const server = createServer((req, res) => {
    applySecurityHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403); res.end(); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
    }
    const path = req.url.split('?')[0];
    const key = path === demo ? demo + 'index.html' : path;
    const bytes = files.get(key);
    if (!bytes) { res.writeHead(404); res.end(); return; }
    const html = key.endsWith('.html');
    if (html) res.setHeader('Content-Security-Policy', htmlCsp(bytes));
    res.writeHead(200, { 'Content-Length': bytes.length,
      'Content-Type': html ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  return server;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function run(file, env) {
  const child = spawn(process.execPath, [file], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 0, `${file}: exit=${code} signal=${signal}`);
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'velance-private-gpu-'));
  let paintServer, delivery;
  try {
    const storeDir = join(temp, 'release');
    const release = await createSnapshot({ sourceRoot: ROOT, storeDir });
    await activateRelease({ storeDir, id: release.id });
    const files = new Map();
    // The demo is intentionally not included in the public release; only the
    // two demo files plus its released JS dependencies enter the fixture.
    for (const entry of release.manifest.files) {
      if (/^\/(?:vendor\/three\/.*|packages\/tsl-carpaint\/src\/.*)\.js$/.test(entry.path))
        files.set(entry.path, readFileSync(join(release.root, entry.path)));
    }
    for (const name of ['index.html', 'app.js']) {
      const path = demo + name;
      const local = join(ROOT, path);
      assert(lstatSync(local).isFile(), `Expected regular demo file: ${path}`);
      files.set(path, readFileSync(local));
    }
    paintServer = createPaintFixtureServer(files);
    const paintOrigin = await listen(paintServer);
    const paintShots = join(temp, 'paint');
    mkdirSync(paintShots);
    await run('packages/tsl-carpaint/test/gpu.mjs', { TEST_ORIGIN: paintOrigin, QA_SHOTS: paintShots });
    await close(paintServer);
    delivery = createDeliveryServer({ storeDir });
    const origin = await listen(delivery);
    console.log(`[GPU CI] Immutable release ${release.id}`);
    const testOrigin = `${origin}/r/${release.id}`;
    await run('tools/perf/frontend_memory_smoke.mjs', {
      TEST_ORIGIN: testOrigin, QA_SHOT_DIR: join(temp, 'memory')
    });
    await run('tools/perf/frontend_landing_smoke.mjs', {
      TEST_ORIGIN: testOrigin, QA_SHOT_DIR: join(temp, 'portal'), QA_BACKEND: 'webgl'
    });
    await run('tools/perf/frontend_archive_smoke.mjs', {
      TEST_ORIGIN: testOrigin, QA_SHOT_DIR: join(temp, 'archive'), QA_BACKEND: '', QA_VIEWPORT: ''
    });
  } finally {
    try { await close(paintServer); } finally {
      try { await delivery?.shutdown(); } finally { rmSync(temp, { recursive: true, force: true }); }
    }
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
