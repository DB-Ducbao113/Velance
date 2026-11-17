// VELANCE P5 handoff gate. Native gate can run in CI without P4 historical evidence.
// Evidence gate proves CURRENT prepared source matches tested immutable release.
// Neither mode authorizes deployment or evaluates production cloud configuration.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshot } from '../delivery/release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ARGS = process.argv.slice(2);
let mode = 'native', out = null;
for (let i = 0; i < ARGS.length; i += 2) {
  assert(ARGS[i + 1] && !ARGS[i + 1].startsWith('--'), 'Expected --mode native|evidence [--out new.json]');
  if (ARGS[i] === '--mode') mode = ARGS[i + 1];
  else if (ARGS[i] === '--out') out = resolve(ARGS[i + 1]);
  else throw new Error('Unknown P5 gate option: ' + ARGS[i]);
}
assert(['native', 'evidence'].includes(mode), 'Allowed P5 modes: native, evidence');
assert(Number(process.versions.node.split('.')[0]) >= 24, 'P5 native gate requires Node >=24');
if (out) assert(!existsSync(out), 'P5 report output is create-only: ' + out);

function runNode(label, file) {
  const result = spawnSync(process.execPath, [file], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write('[P5] ' + label + ' FAIL\n' + (result.stdout || '').slice(-12000)
      + '\n' + (result.stderr || '').slice(-12000));
    process.exit(1);
  }
  process.stdout.write('[P5] ' + label + ' PASS\n');
}
const steps = [
  ['vendored runtime integrity', 'tools/vendor/verify.mjs'],
  ['optimized GLB byte/triangle budgets', 'tools/optimize/budget.mjs'],
  ['P4 native, P3 and P2 regression', 'tools/perf/p4_check.mjs']
];
for (const [name, file] of steps) runNode(name, file);

const details = { format: 'velance-p5-handoff-check/1', timestamp: new Date().toISOString(),
  mode, node: process.version, nativeQualityGate: 'PASS', sourceMatchesAcceptedRelease: 'NOT_CHECKED',
  publicLaunch: 'NOT_AUTHORIZED' };
if (mode === 'evidence') {
  const results = join(ROOT, 'tools/perf/results');
  const accept = JSON.parse(readFileSync(join(results, 'p4-extended-acceptance.json'), 'utf8'));
  assert.equal(accept.result, 'PASS_LOCAL', 'P4 strict extended acceptance was not PASS_LOCAL');
  assert(Object.values(accept.groups).every(group => Object.values(group).every(result => result.passed)),
    'P4 extended report had an individual failed gate');
  const virtual = JSON.parse(readFileSync(join(results, 'p4-real-asset-virtual-10-25-50-100.json'), 'utf8'));
  const webgpu = JSON.parse(readFileSync(join(results, 'p4-multitab-webgpu-4.json'), 'utf8'));
  const webgl = JSON.parse(readFileSync(join(results, 'p4-multitab-webgl2-4.json'), 'utf8'));
  const tmp = mkdtempSync(join(tmpdir(), 'velance-p5-current-source-'));
  try {
    const release = await createSnapshot({ sourceRoot: ROOT, storeDir: tmp });
    const expectedId = virtual.assets?.releasedId;
    assert(/^[0-9a-f]{64}$/.test(expectedId), 'P4 asset release id is absent or malformed');
    assert.equal(release.id, expectedId, 'Prepared source has changed since P4 full-asset test');
    assert.equal(webgpu.release?.id, release.id, 'P4 WebGPU tabs tested a different release');
    assert.equal(webgl.release?.id, release.id, 'P4 WebGL2 tabs tested a different release');
    assert.equal(release.manifest.files.length, 125, 'Unexpected public asset snapshot count');
    details.sourceMatchesAcceptedRelease = true;
    details.releaseId = release.id;
    details.snapshotFiles = release.manifest.files.length;
    details.p4ExtendedAcceptance = 'PASS_LOCAL';
    process.stdout.write('[P5] Current release fingerprint and all P4 evidence: PASS_LOCAL\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
if (out) writeFileSync(out, JSON.stringify(details, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(details, null, 2));
