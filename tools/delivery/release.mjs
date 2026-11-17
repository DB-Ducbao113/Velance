// Immutable, byte-for-byte static release snapshots for local P3 review.
// Only paths accepted by the shared release allowlist enter a snapshot.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { publicPath } from './static.mjs';

const FORMAT = 'velance-static-release/1';
const ID = /^[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const MANIFEST_FILE = 'manifest.json';
const POINTER_FILE = 'active.json';
const PRIVATE_TOP_LEVEL = new Set(['.git', '.github', 'ops', 'docs', 'tools']);
const PUBLIC_TREES = ['src', 'styles', 'vendor', 'assets/models', 'assets/images', 'assets/environment', 'packages/tsl-carpaint'];

function reject(code) { throw Object.assign(new Error(code), { code }); }
function requiredDirectory(path, name) {
  if (typeof path !== 'string' || !path.trim()) reject(`BAD_${name}`);
  return resolve(path);
}
function releaseId(id) {
  if (typeof id !== 'string' || !ID.test(id)) reject('BAD_RELEASE_ID');
  return id;
}
function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(manifest) { return `${JSON.stringify(manifest, null, 2)}\n`; }
function fileEntry(path, bytes, digest) { return { path, bytes, sha256: digest }; }
function canonicalManifest(files) { return { format: FORMAT, files }; }
function pathValid(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('%') || /[\0-\x1f\x7f]/.test(path)) return false;
  if (path.slice(1).split('/').some(segment => !segment || segment === '.' || segment === '..')) return false;
  return publicPath(path, { release: true }) === true;
}
function sortFiles(files) { return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); }
function exists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function directory(path, missingCode, invalidCode) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') reject(missingCode); throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) reject(invalidCode);
  return realpathSync(path);
}
function regularFile(path, missingCode, invalidCode) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') reject(missingCode); throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) reject(invalidCode);
  return stat;
}
function storePath(storeDir, create = false) {
  const path = requiredDirectory(storeDir, 'STORE_DIR');
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  return directory(path, 'STORE_MISSING', 'STORE_INVALID');
}
function releasesPath(store, create = false) {
  const path = join(store, 'releases');
  if (create && !exists(path)) mkdirSync(path, { mode: 0o700 });
  directory(path, 'RELEASES_MISSING', 'RELEASES_INVALID');
  return path;
}
function fsyncFile(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function fsyncDir(path) {
  try { fsyncFile(path); } catch (error) { if (!['EINVAL', 'EBADF', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error; }
}
function writeNew(path, data, mode = 0o444) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
function writePointer(store, state) {
  const temp = join(store, `.tmp-active-${randomBytes(8).toString('hex')}`);
  try {
    writeNew(temp, `${JSON.stringify(state)}\n`, 0o600);
    renameSync(temp, join(store, POINTER_FILE));
    fsyncDir(store);
  } finally { rmSync(temp, { force: true }); }
  return state;
}

// Reads the switch atomically. A missing pointer means no release was activated.
export function readActiveRelease({ storeDir }) {
  const path = requiredDirectory(storeDir, 'STORE_DIR');
  if (!exists(path)) return null;
  const store = storePath(path);
  const pointer = join(store, POINTER_FILE);
  if (!exists(pointer)) return null;
  const stat = regularFile(pointer, 'POINTER_MISSING', 'POINTER_INVALID');
  if (stat.size > 512) reject('POINTER_INVALID');
  let value;
  try { value = JSON.parse(readFileSync(pointer, 'utf8')); } catch { reject('POINTER_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'active') || !Object.hasOwn(value, 'previous')
    || !ID.test(value.active) || (value.previous !== null && !ID.test(value.previous)) || value.previous === value.active) reject('POINTER_INVALID');
  return { active: value.active, previous: value.previous };
}

function maybePublicSymlink(rel) {
  return PUBLIC_TREES.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`) || prefix.startsWith(`${rel}/`));
}
function excluded(rel, name) {
  if (name.startsWith('.') || name === 'node_modules') return true;
  const parts = rel.split('/');
  return (parts.length === 1 && PRIVATE_TOP_LEVEL.has(name))
    || (parts[0] === 'assets' && ['models_original', 'models_prepared'].includes(parts[1]));
}

// Walk only regular file entries. In particular, never follow a symlink during discovery.
function publicSources(root, store) {
  const found = [];
  function walk(dir, segments) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const parts = [...segments, entry.name], rel = parts.join('/'), path = join(dir, entry.name);
      if (isWithin(store, path) || excluded(rel, entry.name)) continue;
      if (entry.isSymbolicLink()) {
        if (publicPath(`/${rel}`, { release: true }) || maybePublicSymlink(rel)) reject('SOURCE_SYMLINK');
        continue;
      }
      if (entry.isDirectory()) { walk(path, parts); continue; }
      const route = `/${rel}`;
      if (!publicPath(route, { release: true })) continue;
      if (!entry.isFile()) reject('SOURCE_NOT_REGULAR');
      if (!pathValid(route)) reject('BAD_PUBLIC_PATH');
      // The path must remain rooted in the original tree and lead to a public regular file.
      const actual = realpathSync(path);
      if (!isWithin(root, actual) || !pathValid(`/${relative(root, actual).split(sep).join('/')}`)) reject('SOURCE_OUTSIDE_ROOT');
      regularFile(path, 'SOURCE_MISSING', 'SOURCE_NOT_REGULAR');
      found.push({ path: route, source: path });
    }
  }
  walk(root, []);
  return found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

// Read each source file once and checksum exactly the bytes written into staging.
async function copyWithHash(source, dest) {
  let bytes = 0;
  const hash = createHash('sha256');
  const digesting = new Transform({ transform(chunk, _enc, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
  await pipeline(createReadStream(source, { flags: constants.O_RDONLY | constants.O_NOFOLLOW }), digesting,
    createWriteStream(dest, { flags: 'wx', mode: 0o444 }));
  fsyncFile(dest);
  return { bytes, sha256: hash.digest('hex') };
}

export async function createSnapshot({ sourceRoot, storeDir }) {
  const source = directory(requiredDirectory(sourceRoot, 'SOURCE_ROOT'), 'SOURCE_MISSING', 'SOURCE_INVALID');
  const store = storePath(storeDir, true);
  if (isWithin(store, source)) reject('STORE_CONTAINS_SOURCE');
  const releases = releasesPath(store, true);
  const sources = publicSources(source, store);
  if (!sources.length) reject('EMPTY_RELEASE');
  const staging = mkdtempSync(join(releases, '.staging-'));
  try {
    const entries = [];
    for (const file of sources) {
      const dest = join(staging, file.path.slice(1));
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      const copied = await copyWithHash(file.source, dest);
      entries.push(fileEntry(file.path, copied.bytes, copied.sha256));
    }
    const manifest = canonicalManifest(sortFiles(entries));
    const id = sha256(JSON.stringify(manifest));
    writeNew(join(staging, MANIFEST_FILE), canonical(manifest));
    fsyncDir(staging);
    const target = join(releases, id);
    // A content ID may already exist. Never mutate that snapshot or republish over it.
    if (exists(target)) reject('RELEASE_EXISTS');
    const lock = join(releases, `.publish-${id}`);
    try { writeNew(lock, ''); }
    catch (error) { if (error.code === 'EEXIST') reject('RELEASE_IN_PROGRESS'); throw error; }
    try {
      if (exists(target)) reject('RELEASE_EXISTS');
      renameSync(staging, target);
      fsyncDir(releases);
    } finally { rmSync(lock, { force: true }); }
    return { id, root: target, manifest };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

async function hashFile(path) {
  let bytes = 0;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

function parseManifest(text, id) {
  let data;
  try { data = JSON.parse(text); } catch { reject('MANIFEST_INVALID'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 2
    || data.format !== FORMAT || !Array.isArray(data.files) || !data.files.length) reject('MANIFEST_INVALID');
  const files = [];
  let previous = null;
  for (const entry of data.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 3
      || !pathValid(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)
      || (previous !== null && entry.path <= previous)) reject('MANIFEST_INVALID');
    previous = entry.path;
    files.push(fileEntry(entry.path, entry.bytes, entry.sha256));
  }
  const canonicalData = canonicalManifest(files);
  if (text !== canonical(canonicalData) || sha256(JSON.stringify(canonicalData)) !== id) reject('MANIFEST_MISMATCH');
  return canonicalData;
}

// Strictly check files and paths: no unlisted/unauthorized files or symbolic links.
async function checkFiles(root, manifest) {
  const expected = new Map(manifest.files.map(file => [file.path, file]));
  const allowedDirs = new Set();
  for (const record of manifest.files) {
    const parts = record.path.slice(1).split('/');
    for (let i = 1; i < parts.length; i++) allowedDirs.add(parts.slice(0, i).join('/'));
  }
  async function walk(dir, segments) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const parts = [...segments, entry.name], rel = parts.join('/'), path = join(dir, entry.name);
      if (entry.isSymbolicLink()) reject('RELEASE_SYMLINK');
      if (entry.isDirectory()) {
        if (!allowedDirs.has(rel)) reject('RELEASE_EXTRA_FILE');
        await walk(path, parts);
        continue;
      }
      if (!entry.isFile()) reject('RELEASE_INVALID_FILE');
      if (rel === MANIFEST_FILE) continue;
      const route = `/${rel}`;
      const spec = expected.get(route);
      if (!spec || !pathValid(route)) reject('RELEASE_EXTRA_FILE');
      const actual = await hashFile(path);
      if (actual.bytes !== spec.bytes || actual.sha256 !== spec.sha256) reject('RELEASE_CHECKSUM_MISMATCH');
      expected.delete(route);
    }
  }
  await walk(root, []);
  if (expected.size) reject('RELEASE_FILE_MISSING');
}

export async function verifySnapshot({ storeDir, id }) {
  releaseId(id);
  const store = storePath(storeDir);
  const releases = releasesPath(store);
  const root = join(releases, id);
  directory(root, 'RELEASE_MISSING', 'RELEASE_INVALID');
  const file = join(root, MANIFEST_FILE);
  const meta = regularFile(file, 'MANIFEST_MISSING', 'MANIFEST_INVALID');
  if (meta.size > 8 * 1024 * 1024) reject('MANIFEST_INVALID');
  const manifest = parseManifest(readFileSync(file, 'utf8'), id);
  await checkFiles(root, manifest);
  return { id, root, manifest };
}

export async function activateRelease({ storeDir, id }) {
  const { id: verified } = await verifySnapshot({ storeDir, id });
  const current = readActiveRelease({ storeDir });
  if (current?.active === verified) return current;
  return writePointer(storePath(storeDir), { active: verified, previous: current?.active ?? null });
}

export async function rollbackRelease({ storeDir }) {
  const current = readActiveRelease({ storeDir });
  if (!current?.previous) reject('NO_PREVIOUS_RELEASE');
  await verifySnapshot({ storeDir, id: current.previous });
  return writePointer(storePath(storeDir), { active: current.previous, previous: current.active });
}

if (import.meta.main) {
  const [action, ...rest] = process.argv.slice(2);
  const usage = 'Usage: node tools/delivery/release.mjs snapshot --source-root <root> --store-dir <store> | verify --store-dir <store> --id <id> | activate --store-dir <store> --id <id> | rollback --store-dir <store>';
  try {
    const opts = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (!['--source-root', '--store-dir', '--id'].includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--') || Object.hasOwn(opts, rest[i].slice(2))) reject('USAGE');
      opts[rest[i].slice(2)] = rest[i + 1];
    }
    const required = { snapshot: ['source-root', 'store-dir'], verify: ['store-dir', 'id'], activate: ['store-dir', 'id'], rollback: ['store-dir'] }[action];
    if (!required || required.some(key => !opts[key]) || Object.keys(opts).some(key => !required.includes(key))) reject('USAGE');
    const result = action === 'snapshot' ? await createSnapshot({ sourceRoot: opts['source-root'], storeDir: opts['store-dir'] })
      : action === 'verify' ? await verifySnapshot({ storeDir: opts['store-dir'], id: opts.id })
        : action === 'activate' ? await activateRelease({ storeDir: opts['store-dir'], id: opts.id })
          : await rollbackRelease({ storeDir: opts['store-dir'] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.code || 'RELEASE_FAILED', ...(error.code === 'USAGE' ? { usage } : {}) })}\n`);
    process.exitCode = 1;
  }
}
