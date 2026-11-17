#!/usr/bin/env node
// P6 local pre-production gate: no cloud actions, no production DB opens.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshot } from '../delivery/release.mjs';
import { validateStagingFile } from './staging.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
let mode = 'native', out = null;
for (let i = 0; i < args.length; i += 2) {
  assert(args[i + 1] && !args[i + 1].startsWith('--'), 'Usage: --mode native|evidence [--out new.json]');
  if (args[i] === '--mode') mode = args[i + 1];
  else if (args[i] === '--out') out = resolve(args[i + 1]);
  else throw new Error('Unexpected option: ' + args[i]);
}
assert(['native', 'evidence'].includes(mode));
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ required');
if (out) assert(!existsSync(out), 'Evidence file is create-only');

function run(label, command) {
  const result = spawnSync(process.execPath, command, { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`[P6] ${label} FAIL\n${result.stdout?.slice(-12000) || ''}\n${result.stderr?.slice(-12000) || ''}`);
    process.exit(1);
  }
  const pass = /ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(result.stdout);
  process.stdout.write(`[P6] ${label} PASS${pass ? ` (${pass[2]}/${pass[1]}, fail ${pass[3]})` : ''}\n`);
  return pass ? { tests: Number(pass[1]), passed: Number(pass[2]), failed: Number(pass[3]) } : undefined;
}

for (const file of ['tools/p6/staging.mjs', 'tools/p6/check.mjs', 'tools/p6/test/security.mjs'])
  run(`${file} syntax`, ['--check', file]);
const contract = validateStagingFile(join(ROOT, 'config/p6/private-staging.json'));
const security = run('P6 native negative/security matrix', ['--test', '--test-concurrency=1', 'tools/p6/test/security.mjs']);
run('P4/P3/P2 native regression', ['tools/perf/p4_check.mjs']);

const rights = JSON.parse(readFileSync(join(ROOT, 'docs/p5-asset-rights-register.json'), 'utf8'));
assert.equal(rights.entries.length, 96);
const legalCounts = { approved: 0, unverified: 0 };
for (const entry of rights.entries) {
  assert(/^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.bytes));
  const data = readFileSync(join(ROOT, entry.path.slice(1)));
  assert.equal(data.length, entry.bytes, `Asset size mismatch: ${entry.path}`);
  assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, `Asset hash mismatch: ${entry.path}`);
  assert.equal(entry.approvalStatus, 'UNVERIFIED', 'P6 must not accept an unreviewed approval');
  legalCounts.unverified++;
}
assert.equal(legalCounts.unverified, 96);
for (const doc of ['docs/p6-private-staging.md', 'docs/p6-security-privacy.md',
  'docs/p6-recovery-operations.md', 'docs/p6-acceptance.md']) assert(existsSync(join(ROOT, doc)), `Missing ${doc}`);

const report = {
  format: 'velance-p6-local-acceptance/1', assessedAtUtc: new Date().toISOString(),
  node: process.version, mode, result: 'PASS_LOCAL', publicLaunch: 'BLOCKED',
  internetDeploymentAuthorized: false, cloudDeploymentPerformed: false,
  stagingContract: 'VALIDATED_FAIL_CLOSED', p6SecurityTests: security,
  p4P3P2NativeRegression: 'PASS_LOCAL', legalAssetRights: legalCounts,
  publicProviderGates: contract.gates,
  limitations: ['No cloud origin/CDN/TLS/WAF/SSO/MFA deployed or verified',
    'Local loopback fixtures only; no WAN/24-hour soak or real-device validation',
    'No encrypted off-host backup, independent recovery host, alert delivery or on-call verified',
    'No consent/legal owner signoff; 96 public asset permissions unverified']
};
if (mode === 'evidence') {
  const tmp = mkdtempSync(join(tmpdir(), 'velance-p6-source-'));
  try {
    const snapshot = await createSnapshot({ sourceRoot: ROOT, storeDir: tmp });
    const prior = JSON.parse(readFileSync(join(ROOT, 'tools/perf/results/p5-handoff-evidence.json'), 'utf8'));
    report.currentReleaseId = snapshot.id;
    report.p4AcceptedReleaseId = prior.releaseId;
    report.currentSourceMatchesP4FullBrowserEvidence = snapshot.id === prior.releaseId;
    report.currentSnapshotFiles = snapshot.manifest.files.length;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const db = join(ROOT, 'tools/ops/telemetry.db');
  if (existsSync(db)) {
    const stat = statSync(db);
    report.realDatabase = { touchedByGate: false, sizeAtEnd: stat.size, mtimeMsAtEnd: stat.mtimeMs };
  }
}
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
