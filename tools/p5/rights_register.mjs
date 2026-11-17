// Create a REVIEW TEMPLATE from the exact 16 GLBs and 80 editorial WebP images.
// Unknown legal rights stay unknown; checksums and file presence are NOT licenses.
// Output is create-only. Never auto-approve assets or publish them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ARGS = process.argv.slice(2);
assert(ARGS.length === 2 && ARGS[0] === '--out' && ARGS[1] && !ARGS[1].startsWith('--'),
  'Usage: node tools/p5/rights_register.mjs --out docs/p5-asset-rights-register.json');
const out = resolve(ROOT, ARGS[1]);
assert(!existsSync(out), 'Refusing to overwrite an existing rights review: ' + out);
const manifest = JSON.parse(readFileSync(join(ROOT, 'assets/models/manifest.json'), 'utf8'));
assert(manifest.entries?.length === 16, 'Expected 16 source GLB metadata entries');
const sourceDirectory = join(ROOT, 'assets/models');
const modelPaths = readdirSync(sourceDirectory).filter(file => file.endsWith('.glb')).sort();
assert(modelPaths.length === 16, 'Expected exactly 16 GLB files, not a partial model release');
const approved = new Set(manifest.entries.map(entry => entry.file));
assert(modelPaths.every(file => approved.has(file)), 'Actual GLB inventory and prepared metadata differ');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const entries = [];
function record(publicPath, kind, extra = {}) {
  const realPath = join(ROOT, publicPath.slice(1));
  const stat = lstatSync(realPath);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Asset must be a regular file: ' + publicPath);
  const bytes = readFileSync(realPath);
  return {
    path: publicPath, kind, bytes: bytes.length, sha256: sha(bytes), ...extra,
    authorOrOwner: null, originalSourceUrl: null, originalSourceProof: null,
    licenseName: null, exactLicenseUrl: null,
    permitsModification: null, permitsModelConversion: null,
    permitsSelfHostedWebGLDistribution: null, permitsCommercialWebsite: null,
    permitsRenderDerivativeDistribution: null, attributionRequired: null,
    requiredAttributionText: null, independentProvenanceChecked: null,
    rightsEvidenceFile: null, reviewer: null, reviewedAtUtc: null,
    approvalStatus: 'UNVERIFIED'
  };
}
for (const file of modelPaths) {
  const info = manifest.entries.find(entry => entry.file === file);
  const item = record('/assets/models/' + file, 'prepared_3d_model');
  assert.equal(item.bytes, info.bytes, 'GLB metadata size mismatch: ' + file);
  assert.equal(item.sha256, info.sha256, 'GLB metadata hash mismatch: ' + file);
  entries.push(item);
}
const imageRoot = join(ROOT, 'assets/images');
const folders = readdirSync(imageRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
assert.equal(folders.length, 16, 'Expected 16 car photo albums');
for (const folder of folders) {
  const directory = join(imageRoot, folder);
  assert(!lstatSync(directory).isSymbolicLink(), 'Unexpected symlink album: ' + folder);
  const images = readdirSync(directory).filter(file => file.endsWith('.webp')).sort();
  assert.equal(images.length, 5, 'Expected five editorial WebPs per album: ' + folder);
  for (const file of images) entries.push(record('/assets/images/' + folder + '/' + file, 'derived_editorial_render',
    { carAlbum: folder }));
}
assert.equal(entries.length, 96);
const register = { format: 'velance-p5-asset-rights-register/1',
  generatedAtUtc: new Date().toISOString(), publicUseAllowed: false,
  instructions: [
    'The register is a blank legal/provenance review template. UNVERIFIED is not an allegation of infringement.',
    'Checksums prove file identity, not legal permission.',
    'For each GLB supply original creator/source, exact license, modification/conversion/self-hosted WebGL and commercial rights, evidence and reviewer.',
    'For each WebP supply rights to the original 3D model and derivative rendered image; keep render process source and attribution obligations.',
    'Only a rights reviewer can approve a file. No script may infer rights from a file name containing "free".',
    'Do not publish until all included models and rendered WebPs are cleared and evidence retained.'
  ],
  counts: { models: 16, webpRenders: 80, total: 96, unverified: 96, approved: 0 },
  entries };
writeFileSync(out, JSON.stringify(register, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output: out, counts: register.counts,
  publicUseAllowed: false, meaning: 'Blank review register; no license assumed or verified' }, null, 2));
