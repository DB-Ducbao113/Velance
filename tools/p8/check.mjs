#!/usr/bin/env node
// P8: local security/CI gate with NO remote calls, no deployment and no
// publication of unverified 3D assets. GitHub Actions may run this identically.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
let out = null, mode = 'native';
for (let i = 0; i < args.length; i += 2) {
  const arg = args[i], value = args[i + 1];
  assert(value && !value.startsWith('--'), 'Usage: --mode native [--out tools/perf/results/p8-native-*.json]');
  if (arg === '--mode') mode = value;
  else if (arg === '--out') {
    assert(/^tools\/perf\/results\/p8-native-[a-zA-Z0-9_-]+\.json$/.test(value), 'Refuse non-evidence path');
    out = join(ROOT, value);
  } else throw new Error('Unsupported P8 option ' + arg);
}
assert.equal(mode, 'native', 'P8 only supports local/CI-native mode; no deploy mode exists');
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node.js 24+ required');
if (out) assert(!existsSync(out), 'Evidence file exists; refusing overwrite');

const dbPath = join(ROOT, 'tools/ops/telemetry.db');
function meta() {
  if (!existsSync(dbPath)) return null;
  const stat = statSync(dbPath);
  return { bytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
const initialDB = meta();
const steps = [];
function run(name, argv) {
  const started = performance.now();
  const r = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CI: 'true' } });
  if (r.error || r.status !== 0) {
    process.stderr.write(`[P8] FAIL ${name}: exit=${r.status}\n${(r.stdout || '').slice(-8000)}\n${(r.stderr || '').slice(-8000)}\n`);
    process.exitCode = 1;
    throw r.error || new Error('P8_FAIL_CLOSED: ' + name);
  }
  const tap = /ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(r.stdout);
  const result = { name, status: 'PASS', elapsedMs: Math.round(performance.now() - started),
    ...(tap ? { tests: Number(tap[1]), passed: Number(tap[2]), failed: Number(tap[3]) } : {}) };
  steps.push(result);
  process.stdout.write(`[P8] ${name}: PASS${tap ? ' ' + tap[2] + '/' + tap[1] : ''}\n`);
}

try {
  run('P8 security scanner', ['tools/p8/security.mjs', '--mode', 'ci']);
  for (const path of ['tools/p8/check.mjs', 'tools/delivery/security-headers.mjs',
    'tools/delivery/server.mjs', 'tools/delivery/static.mjs', 'tools/ops/server.mjs']) {
    run('syntax ' + path, ['--check', path]);
  }
  const testFiles = readdirSync(join(ROOT, 'tools/p8/test')).filter(x => x.endsWith('.mjs')).sort()
    .map(x => 'tools/p8/test/' + x);
  assert(testFiles.includes('tools/p8/test/headers.mjs'), 'Missing P8 HTTP security test');
  assert(testFiles.includes('tools/p8/test/security.mjs'), 'Missing P8 policy mutation tests');
  run('P8 native security regression', ['--test', '--test-concurrency=1', ...testFiles]);
  run('P7 security/rights/zero-cost regression', ['tools/p7/check.mjs', '--mode', 'native']);
  run('P6/P4/P3/P2 nested native regression', ['tools/p6/check.mjs', '--mode', 'native']);
  const afterDB = meta();
  assert.deepEqual(afterDB, initialDB, 'Real telemetry.db changed during P8 gate');
  const report = { format: 'velance-p8-local-security-ci/1', createdAtUtc: new Date().toISOString(),
    result: 'PASS_LOCAL_NATIVE', node: process.version, costVnd: 0,
    cloudDeploymentPerformed: false, commitPushMergePerformed: false, publicLaunch: 'NO_GO',
    licensedAssetsApprovedByP8: 0, steps, realDB: { before: initialDB, after: afterDB, unchanged: true },
    limits: [
      'No real provider TLS/WAF/SSO/MFA or off-host recovery was verified',
      'P8 browser CSP test is separate from this native CI run; no claim of GPU browser validation in CI',
      '96 GLB/WebP rights and 2 public environment WebP rights remain unverified',
      'CI local pass does not authorize production deploy'
    ] };
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  process.stderr.write('[P8] FAIL_CLOSED ' + (error.message || String(error)) + '\n');
  process.exitCode = 1;
}
