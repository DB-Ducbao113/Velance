import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRTextureBasisu } from '@gltf-transform/extensions';
import { dequantize, weld, join, prune, dedup, reorder, simplify, normals, textureCompress, listTextureSlots } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { bakeStatic } from './bake-static.mjs';
import { inspectGLB, checkBudget } from './budget.mjs';

function countTriangles(document) {
  let tris = 0;
  for (const mesh of document.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    if (pos) tris += (p.getIndices() ? p.getIndices().getCount() : pos.getCount()) / 3;
  }
  return tris;
}
// meshopt's simplify error is absolute in mesh units, so scale it to the model's
// extent (source GLBs arrive in metres, decimetres or millimetres).
function boundsDiagonal(document) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of document.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    if (!pos) continue;
    const a = pos.getArray();
    for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) {
      if (a[i + k] < min[k]) min[k] = a[i + k];
      if (a[i + k] > max[k]) max[k] = a[i + k];
    }
  }
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
}

// Area-weighted normals averaged across shared positions. weld() cannot merge
// flat-shaded soup that carries per-face UVs, so smooth shading without welding.
function smoothNormals(document) {
  for (const mesh of document.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    if (!pos) continue;
    const pa = pos.getArray();
    const count = pa.length / 3;
    const ia = p.getIndices() ? p.getIndices().getArray() : null;
    const key = i => `${pa[i * 3].toFixed(4)},${pa[i * 3 + 1].toFixed(4)},${pa[i * 3 + 2].toFixed(4)}`;
    const acc = new Map();
    const tris = (ia ? ia.length : count) / 3;
    for (let t = 0; t < tris; t++) {
      const a = ia ? ia[t * 3] : t * 3, b = ia ? ia[t * 3 + 1] : t * 3 + 1, c = ia ? ia[t * 3 + 2] : t * 3 + 2;
      const ax = pa[a * 3], ay = pa[a * 3 + 1], az = pa[a * 3 + 2];
      const bx = pa[b * 3] - ax, by = pa[b * 3 + 1] - ay, bz = pa[b * 3 + 2] - az;
      const cx = pa[c * 3] - ax, cy = pa[c * 3 + 1] - ay, cz = pa[c * 3 + 2] - az;
      const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
      for (const v of [a, b, c]) {
        const k = key(v);
        let s = acc.get(k);
        if (!s) { s = [0, 0, 0]; acc.set(k, s); }
        s[0] += nx; s[1] += ny; s[2] += nz;
      }
    }
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const s = acc.get(key(i)) || [0, 1, 0];
      const l = Math.hypot(s[0], s[1], s[2]) || 1;
      out[i * 3] = s[0] / l; out[i * 3 + 1] = s[1] / l; out[i * 3 + 2] = s[2] / l;
    }
    p.setAttribute('NORMAL', document.createAccessor().setType('VEC3').setArray(out));
    p.setAttribute('TANGENT', null);
  }
}

const args = process.argv.slice(2);
const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const input = resolve(flag('--input', fileURLToPath(new URL('../../assets/models_original/', import.meta.url))));
const output = resolve(flag('--out', fileURLToPath(new URL('../../assets/models_prepared/', import.meta.url))));
if (input === output) throw new Error('Choose a separate output directory; source files are never overwritten');
const ktx2 = args.includes('--ktx2');
const exclude = (flag('--exclude', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const triCap = +flag('--tri-cap', 260000);
// Low-poly sources authored as flat-shaded triangle soup read as faceted plastic
// under showroom lighting; weld by position and rebuild smooth normals for them.
const smooth = (flag('--smooth', 'lamborghini_aventador.glb') || '').split(',').map(s => s.trim()).filter(Boolean);
if (ktx2) {
  try { execFileSync('toktx', ['--version'], { stdio: 'ignore' }); }
  catch { throw new Error('--ktx2 requires the KTX-Software toktx encoder on PATH'); }
}
await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder, 'meshopt.simplifier': MeshoptSimplifier });
const files = readdirSync(input).filter(file => file.endsWith('.glb') && !exclude.includes(file) && (!args.includes('--file') || file === flag('--file'))).sort();
if (!files.length) throw new Error('No input GLB files found');
mkdirSync(output, { recursive: true });
const report = [];
for (const file of files) {
  const source = pathJoin(input, file);
  const document = await io.read(source);
  await document.transform(dequantize());
  bakeStatic(document);
  await document.transform(prune(), dedup(), weld(), join(), prune());
  let tris = countTriangles(document);
  if (tris > triCap) {
    const extent = boundsDiagonal(document) * .01;
    await document.transform(simplify({ simplifier: MeshoptSimplifier, ratio: triCap / tris, error: extent }), prune());
    tris = countTriangles(document);
    if (tris > triCap * 1.15) {
      // Flat-shaded triangle soup shares no vertices, so edge collapse stalls.
      // Drop hard normals, weld by position, decimate, then rebuild smooth normals.
      for (const mesh of document.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) { p.setAttribute('NORMAL', null); p.setAttribute('TANGENT', null); }
      await document.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: triCap / tris, error: extent }), prune(), normals({ overwrite: true }));
    }
  }
  if (smooth.includes(file)) {
    smoothNormals(document);
    await document.transform(prune());
  }
  if (ktx2) {
    document.createExtension(KHRTextureBasisu).setRequired(true);
    const scratch = mkdtempSync(pathJoin(tmpdir(), 'velance-ktx2-'));
    try {
      for (const [i, texture] of document.getRoot().listTextures().entries()) {
        const png = pathJoin(scratch, `${i}.png`), result = pathJoin(scratch, `${i}.ktx2`);
        await sharp(texture.getImage()).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toFile(png);
        const srgb = listTextureSlots(texture).some(slot => slot === 'baseColorTexture' || slot === 'emissiveTexture');
        execFileSync('toktx', ['--t2', '--encode', 'uastc', '--uastc_quality', '2', '--zcmp', '18', '--genmipmap', '--assign_oetf', srgb ? 'srgb' : 'linear', result, png], { stdio: 'pipe' });
        texture.setImage(readFileSync(result)).setMimeType('image/ktx2');
      }
    } finally { rmSync(scratch, { recursive: true }); }
  } else {
    await document.transform(textureCompress({ encoder: sharp, formats: /^image\/(jpeg|png)$/, resize: [1024, 1024], targetFormat: 'webp', quality: 82 }));
  }
  await document.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }));
  document.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  document.getRoot().getAsset().extras = { velancePrepared: 2 };
  const destination = pathJoin(output, file);
  await io.write(destination, document);
  const entry = inspectGLB(readFileSync(destination), file);
  if (entry.skins) throw new Error(`Skin bake incomplete: ${file}`);
  report.push(entry);
  console.log(`${file}: ${(entry.bytes / 1048576).toFixed(2)} MiB, ${entry.triangles} triangles, ${entry.primitives} primitives`);
}
const budget = checkBudget(report);
writeFileSync(pathJoin(output, 'manifest.json'), JSON.stringify({ version: 2, textureFormat: ktx2 ? 'ktx2-uastc' : 'webp', entries: report, ...budget }, null, 2));
if (budget.failures.length) throw new Error(budget.failures.join('\n'));
console.log(`Prepared ${report.length} assets; payload ${(budget.bytes / 1048576).toFixed(2)} MiB, budget PASS`);
