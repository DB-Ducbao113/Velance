import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../../assets/models/', import.meta.url));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

for (const f of readdirSync(DIR).filter(f => f.endsWith('.glb'))) {
  const doc = await io.read(join(DIR, f));
  const root = doc.getRoot();
  const texs = root.listTextures();
  let tri = 0, verts = 0;
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    if (!pos) continue;
    verts += pos.getCount();
    tri += (p.getIndices() ? p.getIndices().getCount() : pos.getCount()) / 3;
  }
  const texInfo = [];
  for (const t of texs) {
    const img = t.getImage();
    let w = 0, h = 0;
    try { const meta = await sharp(img).metadata(); w = meta.width; h = meta.height; } catch {}
    const users = root.listMaterials().filter(m =>
      m.getBaseColorTexture() === t || m.getNormalTexture() === t || m.getMetallicRoughnessTexture() === t ||
      m.getEmissiveTexture() === t || m.getOcclusionTexture() === t).map(m => m.getName() || '(unnamed)');
    texInfo.push({ name: t.getName() || '(unnamed)', mime: t.getMimeType(), kb: Math.round(img.length / 1024), w, h, users: [...new Set(users)].slice(0, 4) });
  }
  const mats = root.listMaterials().map(m => ({
    name: m.getName() || '(unnamed)',
    base: m.getBaseColorFactor().slice(0, 3).map(v => +v.toFixed(2)),
    metal: +m.getMetallicFactor().toFixed(2), rough: +m.getRoughnessFactor().toFixed(2),
    cc: m.getExtension('KHR_materials_clearcoat') ? +m.getExtension('KHR_materials_clearcoat').getClearcoatFactor().toFixed(2) : 0,
    tex: !!(m.getBaseColorTexture() || m.getNormalTexture() || m.getMetallicRoughnessTexture())
  }));
  console.log(JSON.stringify({
    file: f, mb: +(statSync(join(DIR, f)).size / 1048576).toFixed(1),
    nodes: root.listNodes().length, meshes: root.listMeshes().length, tris: Math.round(tri), verts,
    textures: texInfo.sort((a, b) => b.kb - a.kb), materials: mats
  }, null, 1));
}