#!/usr/bin/env node
// P7 local pre-production gate. No cloud calls, no writes to telemetry.db,
// no asset license approvals or automatic public release.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLocal } from './rights.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), opts = { mode: 'native', out: null, browser: null };
for (let i = 0; i < args.length; i += 2) {
  assert(args[i + 1] && !args[i + 1].startsWith('--'), 'Usage: --mode native|evidence [--out new.json] [--browser report.json]');
  if (args[i] === '--mode') opts.mode = args[i + 1];
  else if (args[i] === '--out') opts.out = resolve(ROOT, args[i + 1]);
  else if (args[i] === '--browser') {
    assert(/^tools\/perf\/results\/p7-lazy-browser-[a-zA-Z0-9_-]+\.json$/.test(args[i + 1]), 'P7 browser evidence must be a local P7 report');
    opts.browser = join(ROOT, args[i + 1]);
  } else throw new Error('Unexpected P7 argument: ' + args[i]);
}
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ required');
assert(['native', 'evidence'].includes(opts.mode));
assert(opts.mode === 'evidence' || opts.browser === null, 'Browser evidence only in evidence mode');
if (opts.out) assert(!existsSync(opts.out), 'Refusing to overwrite prior P7 evidence');

const dbPath = join(ROOT, 'tools/ops/telemetry.db');
const statDB = () => existsSync(dbPath) ? (() => {
  const s = statSync(dbPath); return { bytes: s.size, modifiedMs: s.mtimeMs, changedMs: s.ctimeMs };
})() : null;
const originalDB = statDB();
function run(label, argv) {
  const result = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`[P7] ${label} FAILED\n${String(result.stdout || '').slice(-10000)}\n${String(result.stderr || '').slice(-10000)}\n`);
    process.exit(1);
  }
  const tap = /ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(result.stdout);
  console.log(`[P7] ${label}: PASS${tap ? ` (${tap[2]}/${tap[1]})` : ''}`);
  return tap ? { tests: Number(tap[1]), passed: Number(tap[2]), failed: Number(tap[3]) } : null;
}

for (const file of ['tools/p7/check.mjs', 'tools/p7/rights.mjs', 'tools/p7/browser_lazy.mjs',
  'tools/p7/free-staging.mjs',
  'src/engine/load-policy.js', 'src/engine/showroom.js', 'src/ui/app.js', 'src/telemetry/collector.js']) {
  run('syntax ' + file, ['--check', file]);
}
const tests = readdirSync(join(ROOT, 'tools/p7/test')).filter(file => file.endsWith('.mjs')).sort()
  .map(file => 'tools/p7/test/' + file);
assert(tests.includes('tools/p7/test/rights.mjs') && tests.includes('tools/p7/test/consent.mjs') && tests.includes('tools/p7/test/load-policy.mjs'));
const nativeTests = run('P7 consent, inventory and lazy-load native tests', ['--test', '--test-concurrency=1', ...tests]);
run('P7 zero-cost private loopback staging smoke', ['tools/p7/free-staging.mjs', '--mode', 'smoke']);

const rights = await auditLocal();
assert.equal(rights.localAudit, 'PASS_LOCAL');
assert.equal(rights.publicLaunch, 'NO_GO');
assert.equal(rights.g0LegalGate, 'BLOCKED');
assert.equal(rights.legalDistributionAuthorizedByAudit, false);
assert.equal(rights.registeredRights.total, 96);
assert.equal(rights.registeredRights.models, 16);
assert.equal(rights.registeredRights.webpRenders, 80);
assert.equal(rights.registeredRights.legalSignaturesIndependentlyVerified, 0);
const source = rights.sourceRelease;

let headed = null;
if (opts.browser) {
  const report = JSON.parse(readFileSync(opts.browser, 'utf8'));
  assert.equal(report.format, 'velance-p7-lazy-browser/1');
  assert.equal(report.overall, 'PASS_LOCAL');
  assert.equal(report.releaseId, source.id, 'P7 headed Chrome evidence is for a different source release');
  assert.equal(report.localOnly, true);
  assert.equal(report.runs.length, 2);
  const backends = report.runs.map(r => r.backend).sort();
  assert.deepEqual(backends, ['webgl2', 'webgpu']);
  assert(report.runs.every(r => r.coldModelFiles === 1 && r.afterOverviewModelFiles === 16
    && r.finalLoaded === 16 && r.successfulSelection && r.consentDefaultOff === true
    && r.consentUiAndWithdrawalPass === true && r.telemetryPostCount === 0 && r.errors.length === 0));
  headed = { result: 'PASS_LOCAL', releaseId: report.releaseId,
    backends, coldNetworkBytes: Object.fromEntries(report.runs.map(r => [r.backend, r.coldBytes])),
    report: 'tools/perf/results/' + opts.browser.split('/').at(-1) };
}
const historical = JSON.parse(readFileSync(join(ROOT, 'tools/perf/results/p5-handoff-evidence.json'), 'utf8'));
const report = { format: 'velance-p7-local-acceptance/1', atUtc: new Date().toISOString(), node: process.version,
  result: headed ? 'PASS_LOCAL_BROWSER_AND_NATIVE' : 'PASS_LOCAL_NATIVE',
  publicLaunch: 'NO_GO', internetDeploymentAuthorized: false, cloudDeploymentPerformed: false,
  nativeTests, rightsAudit: { result: rights.localAudit, publicLaunch: rights.publicLaunch,
    g0: rights.g0LegalGate, approved: rights.registeredRights.claimedApproved,
    unverified: rights.registeredRights.unverified,
    additionalRightsNeeded: rights.publicRightsScope.additionalRightsNeeded },
  sourceReleaseId: source.id, sourceReleaseFiles: source.files,
  historicalP4ReleaseId: historical.releaseId,
  historicalP4FullBrowserEvidenceAppliesToCurrentRelease: source.id === historical.releaseId,
  headedBrowser: headed || 'NOT_RUN_IN_THIS_GATE',
  realDatabase: { before: originalDB, after: statDB(), untouched: JSON.stringify(originalDB) === JSON.stringify(statDB()) },
  providerGates: { assetLicenseAndLegalSignoff: 'BLOCKED', privacyLegalSignoff: 'BLOCKED',
    privateOriginCdnTlsWaf: 'NEEDS_PROVIDER_TEST', opsSsoMfaRbac: 'NEEDS_PROVIDER_TEST',
    encryptedOffHostRecovery: 'NEEDS_PROVIDER_TEST', externalAlertDelivery: 'NEEDS_PROVIDER_TEST',
    realMultiRegionWanSoak: 'NEEDS_PROVIDER_TEST', canaryAndProviderRollback: 'NEEDS_PROVIDER_TEST',
    publicOwnerApproval: 'NO_GO' }
};
assert.equal(report.realDatabase.untouched, true, 'Real DB metadata changed during P7 local gate');
for (const doc of ['docs/p7-asset-audit.md', 'docs/p7-telemetry-consent.md',
  'docs/p7-optimization.md', 'docs/p7-acceptance.md'])
  assert(existsSync(join(ROOT, doc)), 'Missing P7 handoff doc: ' + doc);
if (opts.out) writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
