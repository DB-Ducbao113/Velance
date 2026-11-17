import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib';
import { htmlCsp } from './security-headers.mjs';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_ENTRIES = 256;
const MAX_COMPRESS_INPUT = 4 * 1024 * 1024;
const MAX_COMPRESSION_PENDING = 32;
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.avif': 'image/avif',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2'
});
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg']);
const cache = new Map();
const inflight = new Map();
const waiting = [];
let cacheBytes = 0, compressionJobs = 0, compressionReserved = 0;

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };

function safePath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')
    && !/[\\\0\x00-\x1f#?%]/.test(path) && !path.includes('//')
    && !path.split('/').some((part, i) => i && (part === '.' || part === '..' || part === 'node_modules' || part.startsWith('.')));
}

export function publicPath(path, { release = false } = {}) {
  if (!safePath(path)) return false;
  if (['/', '/index.html'].includes(path)) return true;
  if (release) {
    // Publish only the prepared runtime subset. Never expose original masters,
    // alternate image formats, Ops UI, render tooling or repository internals.
    return /^\/(?:src\/.*\.js|styles\/.*\.css|vendor\/.*\.(?:js|wasm)|packages\/tsl-carpaint\/src\/.*\.js|assets\/(?:models\/[^/]+\.glb|images\/.*\.webp|environment\/.*\.webp))$/.test(path);
  }
  if (['/ops/', '/packages/tsl-carpaint/demo/'].includes(path)) return true;
  if (['/ops/index.html', '/ops/ops.js', '/ops/ops.css', '/tools/render/render.html'].includes(path)) return true;
  return /^\/(?:src\/.*\.js|styles\/.*\.css|vendor\/.*\.(?:js|wasm)|packages\/tsl-carpaint\/(?:src\/.*\.js|demo\/(?:index\.html|app\.js))|assets\/(?:models\/[^/]+\.glb|images\/.*\.webp|environment\/.*\.webp))$/.test(path);
}

function filePath(path) {
  if (path === '/') return '/index.html';
  if (path === '/ops/') return '/ops/index.html';
  if (path === '/packages/tsl-carpaint/demo/') return '/packages/tsl-carpaint/demo/index.html';
  return path;
}

function contained(root, file) {
  const rel = relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && rel !== '' && !rel.startsWith(`${sep}`);
}

export async function resolvePublicFile({ root, dbPath = null, path, release = false }) {
  if (!publicPath(path, { release })) fail(404, 'NOT_FOUND');
  let canonicalRoot, file, fileStat;
  const requested = filePath(path);
  try {
    canonicalRoot = await realpath(root);
    file = await realpath(resolve(canonicalRoot, '.' + requested));
    fileStat = await stat(file);
  } catch { fail(404, 'NOT_FOUND'); }
  if (!contained(canonicalRoot, file) || !publicPath('/' + relative(canonicalRoot, file).split(sep).join('/'), { release })
    || !fileStat.isFile()) fail(404, 'NOT_FOUND');
  if (dbPath) {
    let actualDB;
    try { actualDB = await realpath(dbPath); } catch { actualDB = resolve(dbPath); }
    if (file === actualDB || file.startsWith(`${actualDB}-`) || file.startsWith(`${actualDB}.`)) fail(404, 'NOT_FOUND');
  }
  const ext = extname(file).toLowerCase();
  if (!MIME[ext]) fail(404, 'NOT_FOUND');
  return { file, path: requested, stat: fileStat, mime: MIME[ext], ext };
}

function encodingQ(value) {
  if (typeof value !== 'string') return { identity: 1, gzip: 0, br: 0 };
  const parsed = new Map();
  for (const token of value.split(',')) {
    const [name, ...params] = token.trim().toLowerCase().split(';');
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*(\S+)\s*$/.exec(param);
      if (match) { q = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(match[1]) ? Number(match[1]) : 0; break; }
    }
    parsed.set(name.trim(), q);
  }
  const wildcard = parsed.get('*') ?? 0;
  return {
    identity: parsed.get('identity') ?? (parsed.has('*') && wildcard === 0 ? 0 : 1),
    gzip: parsed.get('gzip') ?? wildcard,
    br: parsed.get('br') ?? wildcard
  };
}

function negotiate(header, compressible) {
  const scores = encodingQ(header);
  const ordered = compressible ? ['br', 'gzip', 'identity'] : ['identity'];
  let selected = null, highest = 0;
  for (const candidate of ordered) {
    if (scores[candidate] > highest) { highest = scores[candidate]; selected = candidate; }
  }
  if (!selected) fail(406, 'NOT_ACCEPTABLE');
  return selected;
}

function matchesETag(header, etag) {
  if (typeof header !== 'string') return false;
  return header.split(',').some(part => {
    const value = part.trim();
    return value === '*' || value.replace(/^W\//, '') === etag;
  });
}

function cacheGet(key) {
  const value = cache.get(key);
  if (value) { cache.delete(key); cache.set(key, value); }
  return value;
}

function cacheSet(key, value) {
  if (value.length > CACHE_BYTES) return;
  if (cache.has(key)) { cacheBytes -= cache.get(key).length; cache.delete(key); }
  cache.set(key, value); cacheBytes += value.length;
  while (cache.size > CACHE_ENTRIES || cacheBytes > CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).length; cache.delete(oldest);
  }
}

async function limitedCompression(work) {
  if (compressionJobs >= 2) {
    if (waiting.length >= MAX_COMPRESSION_PENDING) fail(503, 'STATIC_BUSY');
    await new Promise(resolve => waiting.push(resolve));
  }
  compressionJobs++;
  try { return await work(); }
  finally { compressionJobs--; waiting.shift()?.(); }
}

function compress(key, bytes, encoding) {
  const hit = cacheGet(key);
  if (hit) return Promise.resolve(hit);
  if (inflight.has(key)) return inflight.get(key);
  const job = limitedCompression(async () => {
    const output = encoding === 'br'
      ? await brotliAsync(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
      : await gzipAsync(bytes, { level: 6 });
    cacheSet(key, output);
    return output;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function hashHandle(handle) {
  const hash = createHash('sha256');
  for await (const piece of handle.createReadStream({ start: 0, autoClose: false })) hash.update(piece);
  return hash.digest('hex');
}

async function streamHandle(handle, res) {
  await new Promise((done, reject) => {
    const stream = handle.createReadStream({ start: 0, autoClose: false });
    const complete = () => { cleanup(); done(); };
    const failed = error => { cleanup(); stream.destroy(); reject(error); };
    const closed = () => res.writableFinished ? complete() : failed(new Error('static response interrupted'));
    const cleanup = () => { stream.off('error', failed); res.off('close', closed); res.off('finish', complete); };
    stream.once('error', failed);
    res.once('close', closed);
    res.once('finish', complete);
    stream.pipe(res);
  });
}

export async function serveStatic(req, res, { root, dbPath = null, path, search = '', policy = 'mutable', opsHeader = false, verifyFile = null }) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); fail(405, 'METHOD_NOT_ALLOWED'); }
  if (!['mutable', 'immutable'].includes(policy)) fail(500, 'BAD_STATIC_POLICY');
  if (policy === 'mutable' && (path === '/ops' || path === '/packages/tsl-carpaint/demo')) {
    res.writeHead(308, { Location: `${path}/${search}`, 'Cache-Control': 'no-cache' });
    res.end(); return;
  }
  const release = policy === 'immutable';
  const resolved = await resolvePublicFile({ root, dbPath, path, release });
  // Negotiation failures must advertise the same varying request header as a
  // successful representation, so a cache never reuses a 406 for another client.
  res.setHeader('Vary', 'Accept-Encoding');
  const contentEncoding = negotiate(req.headers['accept-encoding'], COMPRESSIBLE.has(resolved.ext));
  let handle, reserved = false;
  try {
    if (contentEncoding !== 'identity') {
      if (compressionReserved >= MAX_COMPRESSION_PENDING + 2) fail(503, 'STATIC_BUSY');
      compressionReserved++; reserved = true;
    }
    // Open the canonical target without following a newly swapped leaf symlink.
    try { handle = await open(resolved.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch { fail(404, 'NOT_FOUND'); }
    const info = await handle.stat();
    if (!info.isFile()) fail(404, 'NOT_FOUND');
    if (resolved.ext === '.html' && info.size > 256 * 1024) fail(413, 'HTML_TOO_LARGE');
    if (contentEncoding !== 'identity' && info.size > MAX_COMPRESS_INPUT) fail(503, 'STATIC_BUSY');
    let bytes = null;
    if (contentEncoding !== 'identity' || info.size <= 256 * 1024) bytes = await handle.readFile();
    const sha256 = bytes ? createHash('sha256').update(bytes).digest('hex') : await hashHandle(handle);
    if (typeof verifyFile === 'function') {
      const verified = await verifyFile({ file: resolved.file, path: resolved.path, sha256, bytes: info.size });
      if (verified === false) fail(503, 'RELEASE_MISMATCH');
    }
    const etag = `"${sha256}-${contentEncoding}"`;
    const headers = {
      'Content-Type': resolved.mime,
      'Cache-Control': release ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Vary': 'Accept-Encoding',
      'ETag': etag,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin'
    };
    if (resolved.ext === '.html') headers['Content-Security-Policy'] = htmlCsp(bytes);
    if (opsHeader && resolved.path.endsWith('/index.html')) headers['X-Velance-Ops'] = '1';
    if (contentEncoding !== 'identity') headers['Content-Encoding'] = contentEncoding;
    if (matchesETag(req.headers['if-none-match'], etag)) {
      res.writeHead(304, headers); res.end(); return;
    }
    if (contentEncoding !== 'identity') bytes = await compress(`${sha256}:${contentEncoding}`, bytes, contentEncoding);
    headers['Content-Length'] = bytes ? bytes.length : info.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    if (bytes) { res.end(bytes); return; }
    await streamHandle(handle, res);
  } finally { if (reserved) compressionReserved--; await handle?.close(); }
}
