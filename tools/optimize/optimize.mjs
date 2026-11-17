/* One-time offline GLB optimization for VELANCE.
 * dequantize + weld + join + meshopt FILTER (geometry), WebP <=1024 (textures).
 * No quantization: runtime bakes node transforms on CPU, quantized node-scale
 * compensation corrupts shared accessors. Originals in assets/models_original/.
 * Run: node scripts/optimize/optimize.mjs
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dequantize, flatten, weld, join, prune, dedup, reorder, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODELS = fileURLToPath(new URL('../../assets/models/', import.meta.url));
const BACKUP = fileURLToPath(new URL('../../assets/models_original/', import.meta.url));

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
mkdirSync(BACKUP, { recursive: true });

const report = [];
for (const f of readdirSync(MODELS).filter(f => f.endsWith('.glb')).sort()) {
  const src = pjoin(MODELS, f);
  const bak = pjoin(BACKUP, f);
  if (!existsSync(bak)) copyFileSync(src, bak);
  const before = statSync(bak).size;
  const t0 = performance.now();
  const doc = await io.read(bak);
  await doc.transform(
    dequantize(),
    flatten(),
    weld(),
    join(),
    prune(),
    dedup(),
    textureCompress({ sharp, resize: [1024, 1024], targetFormat: 'webp', quality: 85 }),
    reorder({ encoder: MeshoptEncoder, target: 'size' })
  );
  doc.createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  await io.write(src, doc);
  const after = statSync(src).size;
  const root = doc.getRoot();
  let tris = 0;
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    if (pos) tris += (p.getIndices() ? p.getIndices().getCount() : pos.getCount()) / 3;
  }
  const entry = { file: f, beforeMB: +(before / 1048576).toFixed(1), afterMB: +(after / 1048576).toFixed(2), ratio: +(before / after).toFixed(1), tris: Math.round(tris), meshes: root.listMeshes().length, seconds: +((performance.now() - t0) / 1000).toFixed(1) };
  report.push(entry);
  console.log(JSON.stringify(entry));
}
const totB = report.reduce((a, r) => a + r.beforeMB, 0), totA = report.reduce((a, r) => a + r.afterMB, 0);
console.log(JSON.stringify({ totalBeforeMB: +totB.toFixed(1), totalAfterMB: +totA.toFixed(1), ratio: +(totB / totA).toFixed(1) }));