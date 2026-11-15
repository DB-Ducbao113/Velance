import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = Object.freeze({ modelBytes: 12 * 1048576, totalBytes: 160 * 1048576, modelTriangles: 300000, totalTriangles: 5000000, modelMaterials: 64 });

export function inspectGLB(buffer, file = '') {
  if (buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`Invalid GLB: ${file}`);
  const json = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString());
  let triangles = 0, primitives = 0;
  for (const mesh of json.meshes || []) for (const primitive of mesh.primitives) {
    if ((primitive.mode ?? 4) !== 4) throw new Error(`Non-triangle geometry: ${file}`);
    const accessor = json.accessors[primitive.indices ?? primitive.attributes.POSITION];
    triangles += accessor.count / 3;
    primitives++;
  }
  return { file, bytes: buffer.length, triangles: Math.round(triangles), primitives, materials: json.materials?.length || 0, textures: json.textures?.length || 0, skins: json.skins?.length || 0, prepared: json.asset.extras?.velancePrepared === 2, sha256: createHash('sha256').update(buffer).digest('hex') };
}

export function checkBudget(entries, limits = LIMITS) {
  const failures = [];
  for (const entry of entries) {
    if (entry.bytes > limits.modelBytes) failures.push(`${entry.file}: payload ${entry.bytes} > ${limits.modelBytes}`);
    if (entry.triangles > limits.modelTriangles) failures.push(`${entry.file}: triangles ${entry.triangles} > ${limits.modelTriangles}`);
    if (entry.materials > limits.modelMaterials) failures.push(`${entry.file}: materials ${entry.materials} > ${limits.modelMaterials}`);
  }
  const bytes = entries.reduce((n, e) => n + e.bytes, 0);
  const triangles = entries.reduce((n, e) => n + e.triangles, 0);
  if (bytes > limits.totalBytes) failures.push(`Total payload ${bytes} > ${limits.totalBytes}`);
  if (triangles > limits.totalTriangles) failures.push(`Total triangles ${triangles} > ${limits.totalTriangles}`);
  return { bytes, triangles, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] || fileURLToPath(new URL('../../assets/models/', import.meta.url)));
  const entries = readdirSync(directory).filter(file => file.endsWith('.glb')).sort().map(file => inspectGLB(readFileSync(join(directory, file)), file));
  if (!entries.length) throw new Error('No GLB models found');
  const report = checkBudget(entries);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json')));
  for (const entry of entries) {
    if (!entry.prepared || entry.skins) report.failures.push(`${entry.file}: run the static asset pipeline first`);
    if (manifest.entries.find(e => e.file === entry.file)?.sha256 !== entry.sha256) report.failures.push(`${entry.file}: manifest checksum mismatch`);
  }
  if (manifest.entries.length !== entries.length) report.failures.push('Manifest asset count mismatch');
  console.log(JSON.stringify({ limits: LIMITS, entries, ...report }, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
