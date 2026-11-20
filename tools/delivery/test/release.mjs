import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activateRelease, createSnapshot, readActiveRelease, rollbackRelease, verifySnapshot } from '../release.mjs';

const file = fileURLToPath(new URL('../release.mjs', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function fixture(t, { fleet = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'velance-delivery-'));
  const sourceRoot = join(temp, 'showroom'), storeDir = join(temp, 'store');
  mkdirSync(sourceRoot);
  const put = (name, bytes = `contents of ${name}`) => {
    const path = join(sourceRoot, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return path;
  };
  put('index.html', Buffer.from('<html>Original GLB assets: no rewrite</html>'));
  put('src/ui/app.js', 'export const phase = "home";');
  put('src/tools/helper.js', 'export default 42;');
  put('styles/main.css', 'body{background:#000}');
  put('vendor/three/three.core.js', '// pinned');
  put('assets/models/car-01.glb', Buffer.from([0x67, 0x6c, 0x54, 0x46, 0, 255]));
  put('assets/images/car-01/angle-1.webp', Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 255]));
  put('assets/environment/studio.webp', Buffer.from([0, 1, 2, 3]));
  put('assets/archive/car01/photo-640.webp', Buffer.from([82,73,70,70]));
  put('assets/hero/portal-1600.webp', Buffer.from([82,73,70,70]));
  if (fleet) {
    for (let i = 1; i <= 16; i++) {
      const car = `car-${String(i).padStart(2, '0')}`;
      put(`assets/models/${car}.glb`, Buffer.from([103, 108, 84, 70, i, 255]));
      for (let frame = 1; frame <= 5; frame++) put(`assets/images/${car}/angle-${frame}.webp`, Buffer.from([82, 73, 70, 70, i, frame]));
    }
  }
  // Forbidden paths exist on disk, but must never enter the release manifest or archive.
  for (const name of [
    'ops/index.html', 'ops/ops.js', 'tools/render/render.html', 'tools/ops/telemetry.db',
    'tools/ops/telemetry.db-wal', 'tools/ops/backups/snapshot.db', '.git/config',
    'node_modules/app/index.js', 'assets/models_original/source.glb',
    'assets/models_prepared/optimized.glb', 'assets/images/car-01/master.png',
    'src/rogue.css', 'assets/images/car-01/cover.jpg', 'assets/archive/car01/.stage-a/photo-640.webp', 'assets/archive/car01/source.jpg', 'assets/hero/portal-source.png', '.env', 'docs/private.md'
  ]) put(name);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return { temp, sourceRoot, storeDir, put };
}

const read = path => readFileSync(path);
const readPointer = store => JSON.parse(readFileSync(join(store, 'active.json'), 'utf8'));

test('source snapshot copies public bytes exactly and never includes Ops, render, DB or master assets', async t => {
  const { sourceRoot, storeDir, put } = fixture(t, { fleet: true });
  const selected = put('src/data/data.json', '{"private":true}');
  const before = read(selected);
  const { id, root, manifest } = await createSnapshot({ sourceRoot, storeDir });
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(root, join(realpathSync(storeDir), 'releases', id));
  assert.equal(lstatSync(join(root, 'index.html')).mode & 0o222, 0, 'snapshots start as read-only files');
  assert.equal(lstatSync(join(root, 'manifest.json')).mode & 0o222, 0, 'manifest is read-only');
  assert.equal(id, sha256(JSON.stringify(manifest)));
  assert.equal(manifest.format, 'velance-static-release/1');
  assert.deepEqual(manifest.files.map(item => item.path), [...manifest.files.map(item => item.path)].sort());
  const modelFiles = manifest.files.filter(entry => entry.path.endsWith('.glb'));
  const imageFiles = manifest.files.filter(entry => entry.path.startsWith('/assets/images/') && entry.path.endsWith('.webp'));
  assert.equal(modelFiles.length, 16, 'all 16 public GLBs must be included');
  assert.equal(imageFiles.length, 80, 'all 80 public five-angle images must be included');
  assert(manifest.files.some(entry => entry.path === '/assets/archive/car01/photo-640.webp'));
  assert(manifest.files.some(entry => entry.path === '/assets/hero/portal-1600.webp'));
  assert(!manifest.files.some(entry => entry.path.includes('/.stage-')));
  assert(manifest.files.some(entry => entry.path === '/src/tools/helper.js'), 'nested public JS directories must not be excluded');
  assert(manifest.files.every(entry => !/(?:\/ops\/|\/tools\/render\/|telemetry\.db|models_original|models_prepared|\.png|\.jpg|\.git\/|node_modules|\.env)/.test(entry.path)));
  assert(!manifest.files.some(entry => entry.path === '/src/data/data.json'));
  assert.deepEqual(read(selected), before, 'input files must remain unchanged');
  for (const entry of manifest.files) {
    const original = read(join(sourceRoot, entry.path.slice(1)));
    const snapshot = read(join(root, entry.path.slice(1)));
    assert.deepEqual(snapshot, original, entry.path);
    assert.equal(entry.bytes, original.length);
    assert.equal(entry.sha256, sha256(original));
  }
  const verified = await verifySnapshot({ storeDir, id });
  assert.deepEqual(verified, { id, root, manifest });
  assert.equal(readActiveRelease({ storeDir }), null, 'creating a snapshot must not activate it');
});

test('a snapshot has deterministic content ID and a duplicate cannot overwrite the old files', async t => {
  const { sourceRoot, storeDir, put } = fixture(t);
  const first = await createSnapshot({ sourceRoot, storeDir });
  const original = read(join(first.root, 'index.html'));
  await assert.rejects(createSnapshot({ sourceRoot, storeDir }), { code: 'RELEASE_EXISTS' });
  assert.deepEqual(read(join(first.root, 'index.html')), original);
  assert.equal(readdirSync(join(storeDir, 'releases')).length, 1, 'no leftover staging directories');
  put('index.html', 'updated release');
  const second = await createSnapshot({ sourceRoot, storeDir });
  assert.notEqual(second.id, first.id);
  assert.deepEqual(read(join(first.root, 'index.html')), original);
  assert.equal(read(join(second.root, 'index.html')).toString(), 'updated release');
});

test('verify rejects changed bytes, manifest rewrites, missing and unlisted release files', async t => {
  const { sourceRoot, storeDir } = fixture(t);
  const release = await createSnapshot({ sourceRoot, storeDir });
  const content = join(release.root, 'index.html');
  const original = read(content);
  chmodSync(content, 0o600);
  writeFileSync(content, Buffer.alloc(original.length, 0x7f)); // same size; hash must catch this.
  await assert.rejects(verifySnapshot({ storeDir, id: release.id }), { code: 'RELEASE_CHECKSUM_MISMATCH' });
  writeFileSync(content, original);
  await verifySnapshot({ storeDir, id: release.id });

  const manifestPath = join(release.root, 'manifest.json');
  const pristine = read(manifestPath);
  chmodSync(manifestPath, 0o600);
  writeFileSync(manifestPath, `${JSON.stringify({ ...release.manifest, files: [] })}\n`);
  await assert.rejects(verifySnapshot({ storeDir, id: release.id }), { code: 'MANIFEST_INVALID' });
  writeFileSync(manifestPath, pristine);

  const added = join(release.root, 'ops', 'index.html');
  mkdirSync(dirname(added), { recursive: true });
  writeFileSync(added, '<p>not public</p>');
  await assert.rejects(verifySnapshot({ storeDir, id: release.id }), { code: 'RELEASE_EXTRA_FILE' });
  rmSync(dirname(added), { recursive: true });
  mkdirSync(join(release.root, 'ops'));
  await assert.rejects(verifySnapshot({ storeDir, id: release.id }), { code: 'RELEASE_EXTRA_FILE' });
  rmSync(join(release.root, 'ops'), { recursive: true });

  rmSync(content);
  await assert.rejects(verifySnapshot({ storeDir, id: release.id }), { code: 'RELEASE_FILE_MISSING' });
});

test('snapshot and verification reject symlinks and malformed release identifiers', async t => {
  const { temp, sourceRoot, storeDir } = fixture(t);
  const outside = join(temp, 'secret.js');
  writeFileSync(outside, 'const secret = true;');
  symlinkSync(outside, join(sourceRoot, 'src', 'linked.js'));
  await assert.rejects(createSnapshot({ sourceRoot, storeDir }), { code: 'SOURCE_SYMLINK' });
  rmSync(join(sourceRoot, 'src', 'linked.js'));
  const folder = join(temp, 'private');
  mkdirSync(folder);
  symlinkSync(folder, join(sourceRoot, 'src', 'external'));
  await assert.rejects(createSnapshot({ sourceRoot, storeDir }), { code: 'SOURCE_SYMLINK' });
  rmSync(join(sourceRoot, 'src', 'external'));
  const release = await createSnapshot({ sourceRoot, storeDir });
  await assert.rejects(verifySnapshot({ storeDir, id: '../secret' }), { code: 'BAD_RELEASE_ID' });
  await assert.rejects(activateRelease({ storeDir, id: '/etc/passwd' }), { code: 'BAD_RELEASE_ID' });
  symlinkSync(outside, join(release.root, 'src', 'injected.js'));
  await assert.rejects(verifySnapshot({ storeDir, id: release.id }), { code: 'RELEASE_SYMLINK' });
  rmSync(join(release.root, 'src', 'injected.js'));
  const second = 'f'.repeat(64);
  symlinkSync(temp, join(storeDir, 'releases', second));
  await assert.rejects(verifySnapshot({ storeDir, id: second }), { code: 'RELEASE_INVALID' });
});

test('activation verifies full snapshot; pointer switches atomically; rollback swaps and retains releases', async t => {
  const { sourceRoot, storeDir, put } = fixture(t);
  assert.equal(readActiveRelease({ storeDir }), null);
  const a = await createSnapshot({ sourceRoot, storeDir });
  assert.deepEqual(await activateRelease({ storeDir, id: a.id }), { active: a.id, previous: null });
  assert.deepEqual(readActiveRelease({ storeDir }), { active: a.id, previous: null });
  assert.deepEqual(await activateRelease({ storeDir, id: a.id }), { active: a.id, previous: null }, 'idempotent activation');
  await assert.rejects(rollbackRelease({ storeDir }), { code: 'NO_PREVIOUS_RELEASE' });
  put('index.html', '<h1>next</h1>');
  const b = await createSnapshot({ sourceRoot, storeDir });
  assert.deepEqual(await activateRelease({ storeDir, id: b.id }), { active: b.id, previous: a.id });
  assert.deepEqual(readPointer(storeDir), { active: b.id, previous: a.id });
  assert.equal(lstatSync(join(storeDir, 'active.json')).mode & 0o777, 0o600, 'pointer mode is owner-only');
  assert.deepEqual(await rollbackRelease({ storeDir }), { active: a.id, previous: b.id });
  assert.deepEqual(await rollbackRelease({ storeDir }), { active: b.id, previous: a.id });
  assert(existsSync(a.root) && existsSync(b.root), 'rollback does not destroy a released snapshot');
  assert.deepEqual((await verifySnapshot({ storeDir, id: a.id })).manifest, a.manifest);
  assert.deepEqual((await verifySnapshot({ storeDir, id: b.id })).manifest, b.manifest);
  assert(!readdirSync(storeDir).some(name => name.startsWith('.tmp-active-')));
});

test('activation and rollback refuse corrupt snapshots without modifying active pointer', async t => {
  const { sourceRoot, storeDir, put } = fixture(t);
  const a = await createSnapshot({ sourceRoot, storeDir });
  await activateRelease({ storeDir, id: a.id });
  put('index.html', 'second release');
  const b = await createSnapshot({ sourceRoot, storeDir });
  const damaged = join(b.root, 'index.html');
  chmodSync(damaged, 0o600);
  writeFileSync(damaged, 'malicious rewrite');
  const pointer = read(join(storeDir, 'active.json'));
  await assert.rejects(activateRelease({ storeDir, id: b.id }), { code: 'RELEASE_CHECKSUM_MISMATCH' });
  assert.deepEqual(read(join(storeDir, 'active.json')), pointer);
  writeFileSync(damaged, 'second release');
  await activateRelease({ storeDir, id: b.id });
  chmodSync(join(a.root, 'index.html'), 0o600);
  writeFileSync(join(a.root, 'index.html'), 'broken');
  const currentPointer = read(join(storeDir, 'active.json'));
  await assert.rejects(rollbackRelease({ storeDir }), { code: 'RELEASE_CHECKSUM_MISMATCH' });
  assert.deepEqual(read(join(storeDir, 'active.json')), currentPointer);
});

test('readActiveRelease rejects tampered pointer and symlink pointer', async t => {
  const { temp, storeDir, sourceRoot } = fixture(t);
  const release = await createSnapshot({ sourceRoot, storeDir });
  const state = await activateRelease({ storeDir, id: release.id });
  const pointer = join(storeDir, 'active.json');
  writeFileSync(pointer, '{"active":"../../etc/passwd","previous":null}\n');
  assert.throws(() => readActiveRelease({ storeDir }), { code: 'POINTER_INVALID' });
  const external = join(temp, 'outside.txt');
  writeFileSync(external, JSON.stringify(state));
  rmSync(pointer);
  symlinkSync(external, pointer);
  assert.throws(() => readActiveRelease({ storeDir }), { code: 'POINTER_INVALID' });
  rmSync(pointer);
  symlinkSync(join(temp, 'missing'), pointer);
  assert.throws(() => readActiveRelease({ storeDir }), { code: 'POINTER_INVALID' });
  assert(lstatSync(pointer).isSymbolicLink());
});

test('CLI snapshot, verify, activate and rollback use the same release contract', async t => {
  const { sourceRoot, storeDir, put } = fixture(t);
  function cli(...args) {
    const run = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  }
  const a = cli('snapshot', '--source-root', sourceRoot, '--store-dir', storeDir);
  assert.equal(cli('verify', '--store-dir', storeDir, '--id', a.id).id, a.id);
  assert.deepEqual(cli('activate', '--store-dir', storeDir, '--id', a.id), { active: a.id, previous: null });
  put('index.html', 'CLI release B');
  const b = cli('snapshot', '--source-root', sourceRoot, '--store-dir', storeDir);
  assert.deepEqual(cli('activate', '--store-dir', storeDir, '--id', b.id), { active: b.id, previous: a.id });
  assert.deepEqual(cli('rollback', '--store-dir', storeDir), { active: a.id, previous: b.id });
  const bad = spawnSync(process.execPath, [file, 'activate', '--store-dir', storeDir, '--id', '../escape'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /BAD_RELEASE_ID/);
});
