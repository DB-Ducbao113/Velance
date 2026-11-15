/* Reproducible three.js vendoring.
 * node vendor-three.mjs [version]   (default below)
 * Fetches the exact npm tarball, verifies its integrity, minifies the ESM builds with esbuild
 * (licence headers kept), copies an allow-list of addons and writes vendor/three/MANIFEST.json.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const VERSION = process.argv[2] || '0.187.0';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'vendor/three');

const BUILDS = ['three.core.js', 'three.tsl.js', 'three.webgpu.js'];
const ADDONS = [
  'loaders/GLTFLoader.js',
  'loaders/KTX2Loader.js',
  'libs/meshopt_decoder.module.js',
  'libs/ktx-parse.module.js',
  'libs/zstddec.module.js',
  'libs/basis/basis_transcoder.js',
  'libs/basis/basis_transcoder.wasm',
  'math/ColorSpaces.js',
  'controls/OrbitControls.js',
  'environments/RoomEnvironment.js',
  'utils/BufferGeometryUtils.js',
  'utils/SkeletonUtils.js',
  'utils/WorkerPool.js'
];

const tmp = mkdtempSync(join(tmpdir(), 'three-vendor-'));
const [pack] = JSON.parse(execFileSync('npm', ['pack', `three@${VERSION}`, '--json', '--pack-destination', tmp], { encoding: 'utf8' }));
const tarball = join(tmp, pack.filename);
const expected = pack.integrity.replace(/^sha512-/, '');
const actual = createHash('sha512').update(readFileSync(tarball)).digest('base64');
if (actual !== expected) throw new Error(`integrity mismatch for three@${VERSION}`);
execFileSync('tar', ['-xzf', tarball, '-C', tmp]);
const PKG = join(tmp, 'package');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const files = {};
const record = (rel, buf) => {
  files[rel] = { bytes: buf.length, gzip: gzipSync(buf, { level: 9 }).length, sha256: createHash('sha256').update(buf).digest('hex') };
};
const minify = async (src, rel) => {
  const code = readFileSync(src, 'utf8');
  const out = await transform(code, { loader: 'js', format: 'esm', minify: true, legalComments: 'inline', target: 'es2022', sourcefile: rel });
  return Buffer.from(out.code);
};

for (const name of BUILDS) {
  const buf = await minify(join(PKG, 'build', name), name);
  writeFileSync(join(OUT, name), buf); record(name, buf);
}
for (const rel of ADDONS) {
  const src = join(PKG, 'examples/jsm', rel);
  if (!existsSync(src)) throw new Error(`addon missing in three@${VERSION}: ${rel}`);
  const dest = join(OUT, 'addons', rel);
  mkdirSync(dirname(dest), { recursive: true });
  if (rel.endsWith('.js') && !rel.includes('basis/')) {
    const buf = await minify(src, rel);
    writeFileSync(dest, buf); record(`addons/${rel}`, buf);
  } else {
    copyFileSync(src, dest); record(`addons/${rel}`, readFileSync(dest));
  }
}
copyFileSync(join(PKG, 'LICENSE'), join(OUT, 'LICENSE'));

const total = Object.values(files).reduce((a, f) => ({ bytes: a.bytes + f.bytes, gzip: a.gzip + f.gzip }), { bytes: 0, gzip: 0 });
writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify({ package: 'three', version: VERSION, integrity: pack.integrity, total, files }, null, 1) + '\n');
rmSync(tmp, { recursive: true, force: true });

const kb = n => `${(n / 1024).toFixed(0)} KB`;
for (const [rel, f] of Object.entries(files)) console.log(`${rel.padEnd(44)} ${kb(f.bytes).padStart(9)}  gz ${kb(f.gzip).padStart(7)}`);
console.log(`three@${VERSION}: ${Object.keys(files).length} files, ${kb(total.bytes)} (gzip ${kb(total.gzip)})`);
