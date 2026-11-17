// Loopback-only release preview. The CDN, TLS, access gateway, and WAF are provider concerns.
import { createServer, request as httpRequest } from 'node:http';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActiveRelease, verifySnapshot } from './release.mjs';
import { serveStatic } from './static.mjs';
import { applySecurityHeaders } from './security-headers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const CAP = 256 * 1024;
const ID_RE = /^[a-f0-9]{64}$/;
const fault = (status, code) => Object.assign(new Error(code), { status, code });
const json = (res, status, code, headers = {}) => {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify({ error: code, code });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', ...headers });
  res.end(body);
};

function toUpstream(value) {
  if (value == null || value === '') return null;
  let url;
  try { url = new URL(value); } catch { throw fault(400, 'BAD_UPSTREAM'); }
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (url.protocol !== 'http:' || !HOSTS.has(hostname) || !url.port || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw fault(400, 'BAD_UPSTREAM');
  return { hostname, host: url.host, port: url.port, origin: url.origin };
}

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}
export function createDeliveryServer({ storeDir, upstream = null } = {}) {
  if (!storeDir) throw fault(400, 'RELEASE_STORE_REQUIRED');
  storeDir = resolve(storeDir);
  const backend = toUpstream(upstream);
  const verified = new Map();
  let closing;

  async function getRelease(id) {
    if (!ID_RE.test(id)) throw fault(404, 'NOT_FOUND');
    const manifestPath = join(storeDir, 'releases', id, 'manifest.json');
    let metadata;
    try { metadata = statSync(manifestPath); } catch { throw fault(404, 'NOT_FOUND'); }
    const token = fingerprint(metadata), previous = verified.get(id);
    if (previous?.token === token) return previous;
    let release;
    try { release = await verifySnapshot({ storeDir, id }); }
    catch { verified.delete(id); throw fault(503, 'RELEASE_MISMATCH'); }
    const lookup = new Map(release.manifest.files.map(f => [f.path.startsWith('/') ? f.path : `/${f.path}`, f]));
    const entry = { ...release, token, lookup };
    // No unbounded release metadata stays live in a long-running preview.
    if (verified.size >= 4) { const first = verified.keys().next().value; verified.delete(first); }
    verified.set(id, entry);
    return entry;
  }

  function verifyFile({ path, sha256, bytes }, release) {
    const record = release.lookup.get(path);
    if (!record) throw fault(404, 'NOT_FOUND');
    // The static resolver hashes the opened file descriptor before writing any
    // response. Comparing this digest avoids a second full GLB disk read.
    if (record.bytes !== bytes || record.sha256 !== sha256) throw fault(503, 'RELEASE_MISMATCH');
  }

  function proxyTelemetry(req, res) {
    if (!backend) throw fault(404, 'NOT_FOUND');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw fault(405, 'METHOD_NOT_ALLOWED'); }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')
      || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
      throw fault(415, 'UNSUPPORTED_MEDIA');
    }
    const declared = req.headers['content-length'];
    if (declared != null && (!/^\d{1,15}$/.test(declared) || Number(declared) > CAP)) {
      if (declared != null && /^\d{1,15}$/.test(declared) && Number(declared) > CAP) throw fault(413, 'PAYLOAD_TOO_LARGE');
      throw fault(400, 'BAD_LENGTH');
    }
    const upstreamHeaders = {
      Host: backend.host, Origin: backend.origin, 'Content-Type': 'application/json',
      ...(declared == null ? {} : { 'Content-Length': declared })
    };
    const back = httpRequest({ hostname: backend.hostname, port: backend.port, path: '/api/telemetry',
      method: 'POST', headers: upstreamHeaders, agent: false, timeout: 10000 }, incoming => {
      if (res.headersSent || res.destroyed) { incoming.resume(); return; }
      const safe = { 'Cache-Control': 'no-store', 'Content-Type': incoming.headers['content-type'] || 'application/json' };
      if (incoming.headers['content-length']) safe['Content-Length'] = incoming.headers['content-length'];
      if (incoming.headers['retry-after']) safe['Retry-After'] = incoming.headers['retry-after'];
      res.writeHead(incoming.statusCode || 502, safe);
      incoming.once('error', () => res.destroy());
      incoming.pipe(res);
    });
    let size = 0, rejected = false;
    const rejectUpload = (status, code) => {
      if (rejected) return;
      rejected = true;
      back.destroy();
      json(res, status, code);
      req.resume();
    };
    back.on('error', () => { if (!rejected && !res.headersSent) json(res, 503, 'UPSTREAM_UNAVAILABLE'); });
    back.on('timeout', () => { back.destroy(); if (!rejected) json(res, 503, 'UPSTREAM_UNAVAILABLE'); });
    req.on('data', bytes => {
      if (rejected) return;
      size += bytes.length;
      if (size > CAP) { rejectUpload(413, 'PAYLOAD_TOO_LARGE'); return; }
      if (!back.write(bytes)) req.pause();
    });
    back.on('drain', () => req.resume());
    req.once('end', () => { if (!rejected) back.end(); });
    req.once('aborted', () => back.destroy());
    req.once('error', () => back.destroy());
    res.once('close', () => { if (!res.writableFinished) back.destroy(); });
  }

  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000,
    maxHeaderSize: 16384 }, async (req, res) => {
    applySecurityHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const host = req.headers.host;
      const match = typeof host === 'string' && /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]+))?$/i.exec(host);
      if (!match || Number(match[2] || 80) !== server.address()?.port) throw fault(400, 'BAD_HOST');
      const origin = `http://${host.toLowerCase()}`;
      if ((req.headers.origin != null && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site')
        throw fault(403, 'CROSS_ORIGIN');
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw fault(400, 'BAD_TARGET');
      let path;
      try { path = decodeURIComponent(req.url.split('?')[0]); } catch { throw fault(400, 'BAD_PATH'); }
      if (/[\\\0\r\n#?]/.test(path) || path.split('/').some(s => s === '.' || s === '..'))
        throw fault(400, 'BAD_PATH');
      const search = new URL(req.url, origin).search;

      if (path === '/api/telemetry') {
        // The edge contract permits exactly this URL, never a query-bearing or
        // percent-encoded alias whose cache/routing semantics may differ.
        if (req.url !== '/api/telemetry') throw fault(404, 'NOT_FOUND');
        proxyTelemetry(req, res); return;
      }
      if (path === '/' || path === '/index.html') {
        if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); throw fault(405, 'METHOD_NOT_ALLOWED'); }
        const active = readActiveRelease({ storeDir })?.active;
        if (!active) throw fault(503, 'RELEASE_NOT_ACTIVE');
        await getRelease(active);
        res.writeHead(307, { Location: `/r/${active}/index.html${search}`, 'Cache-Control': 'no-store' });
        res.end(); return;
      }
      const route = /^\/r\/([a-f0-9]{64})(\/.*)$/.exec(path);
      if (!route) throw fault(404, 'NOT_FOUND');
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); throw fault(405, 'METHOD_NOT_ALLOWED'); }
      const release = await getRelease(route[1]);
      await serveStatic(req, res, { root: release.root, path: route[2], search, policy: 'immutable',
        opsHeader: !!backend, verifyFile: spec => verifyFile(spec, release), release: true });
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, error.status ? error.code : 'INTERNAL');
      else res.destroy();
      req.resume();
    }
  });
  server.maxConnections = 512;
  const close = server.close.bind(server);
  server.shutdown = () => closing ??= new Promise((resolve, reject) => close(err => err ? reject(err) : resolve()));
  return server;
}

if (import.meta.main) {
  const args = process.argv.slice(2), options = { host: '127.0.0.1', port: '8081', store: '', upstream: '' };
  try {
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i].startsWith('--') || !Object.hasOwn(options, args[i].slice(2))
        || !args[i + 1] || args[i + 1].startsWith('--')) throw fault(400, 'USAGE');
      options[args[i].slice(2)] = args[i + 1];
    }
    if (!HOSTS.has(options.host) || !/^\d+$/.test(options.port) || Number(options.port) > 65535 || !options.store)
      throw fault(400, 'USAGE');
    const server = createDeliveryServer({ storeDir: resolve(ROOT, options.store), upstream: options.upstream });
    server.listen(Number(options.port), options.host, () => {
      process.stdout.write(`[delivery] local preview http://${options.host === '::1' ? '[::1]' : options.host}:${server.address().port}\n`);
    });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void server.shutdown());
  } catch (error) {
    process.stderr.write(`[delivery] ${error.code || 'INTERNAL'}\n`);
    process.exitCode = 1;
  }
}
