import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { inspectGLB, checkBudget } from '../budget.mjs';
import { VEHICLES } from '../../../src/data/vehicles.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const models = join(root, 'assets/models');
const MiB = 1048576;
test('all runtime gallery/detail GLBs match their source and manifests and stay within approved resource budgets', async () => {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const names = VEHICLES.map(v => v.file).sort();
  assert.equal(new Set(names).size, 16);
  for (const tier of ['gallery', 'detail']) {
    const dir = join(models, tier);
    assert.deepEqual(readdirSync(dir).filter(n => n.endsWith('.glb')).sort(), names);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const entries = tier === 'gallery' ? manifest.records.map(r => r.after) : manifest.entries;
    assert.deepEqual(entries.map(e => e.file).sort(), names);
    const measured = [];
    let decoded = 0, attributes = 0;
    for (const file of names) {
      const path = join(dir, file);
      const actual = inspectGLB(readFileSync(path), file);
      const source = inspectGLB(readFileSync(join(models, file)), file);
      const record = entries.find(e => e.file === file);
      assert.equal(actual.sha256, record.sha256, path);
      assert.equal(actual.bytes, record.bytes, path);
      assert.equal(actual.triangles, record.triangles, path);
      assert(actual.prepared && !actual.skins, path);
      const doc = await io.read(path);
      let imageBytes = 0, attributeBytes = 0;
      const arrays = new Set();
      for (const texture of doc.getRoot().listTextures()) {
        const { data, info: { width, height, channels } } = await sharp(texture.getImage())
          .raw().toBuffer({ resolveWithObject: true });
        assert(width > 0 && height > 0 && channels > 0 && data.length === width * height * channels, path);
        imageBytes += width * height * 4;
      }
      for (const accessor of doc.getRoot().listAccessors()) {
        const a = accessor.getArray();
        if (a && !arrays.has(a)) { arrays.add(a); attributeBytes += a.byteLength; }
      }
      assert.equal(imageBytes, record.decodedImageBytes, path);
      if (tier === 'detail') {
        assert.equal(actual.triangles, source.triangles, path);
        assert(imageBytes <= 32 * MiB, `${file}: detail texture cap`);
      } else {
        assert(actual.triangles <= source.triangles, path);
        assert.equal(attributeBytes, record.attributeBytes, path);
        assert.equal(manifest.records.find(r => r.file === file).before.sha256, source.sha256, path);
      }
      decoded += imageBytes; attributes += attributeBytes; measured.push(actual);
    }
    const result = checkBudget(measured);
    assert.deepEqual(result.failures, []);
    if (tier === 'gallery') {
      assert(result.bytes <= 24 * MiB && result.triangles <= 1_000_000, JSON.stringify(result));
      assert(decoded <= 80 * MiB && attributes <= 40 * MiB, `${decoded}/${attributes}`);
      assert.equal(decoded, manifest.totals.after.decodedImageBytes);
      assert.equal(attributes, manifest.totals.after.attributeBytes);
    }
    console.log(`${tier}: ${result.bytes} bytes, ${result.triangles} triangles, ${decoded} decoded RGBA bytes`);
  }
});

test('runtime archive passes actual image integrity and source catalog checks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'velance-archive-ci-'));
  try {
    const r = spawnSync(process.execPath, ['tools/perf/archive_asset_audit.mjs'], {
      cwd: root, env: { ...process.env, QA_ASSET_REPORT: join(tmp, 'assets.json') }, encoding: 'utf8'
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const result = JSON.parse(readFileSync(join(tmp, 'assets.json'), 'utf8'));
    assert.equal(result.photographicVehicles, 16);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.orphaned, []);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
