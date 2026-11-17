#!/usr/bin/env node
// Local-only security policy gate. Tests repository release and CI inputs;
// this script has no deploy, credentials, network, database or approval operations.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshot, verifySnapshot } from '../delivery/release.mjs';
import { publicPath } from '../delivery/static.mjs';
import { auditRights } from '../p7/rights.mjs';
import { FREE_STAGING_POLICY } from '../p7/free-staging.mjs';
import { validateStagingContract } from '../p6/staging.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SHA = /^[a-f0-9]{64}$/;
const REVIEWED_LOCAL_DRY_RUN_SHA256 = '1d7df40c1a2af6977c68e7fcd87cdc79df74938f6ac3fcc351faf55a6042e088';
const LEGAL_EXIT = Object.freeze({
  publicLaunch: 'NO_GO',
  automaticLicenseApproval: false,
  cloudDeploymentAuthorized: false
});
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg']);
const PRIVATE_RELEASE = /(?:^\/(?:\.git|\.github|\.env|ops|tools|docs|config|node_modules|assets\/models_original|assets\/models_prepared)(?:\/|$)|(?:^|\/)(?:telemetry\.db(?:[-.]|$)|\.env(?:[./]|$)|[^/]+\.(?:pem|key|p12|pfx|sqlite(?:3)?|log|map|png|bak|zip)$))/i;
const SENSITIVE_FILE = /(^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx)|telemetry\.db(?:[-.].*)?|[^/]+\.sqlite(?:3)?(?:[-.].*)?)$/i;
const IGNORED_REQUIRED = Object.freeze({
  originals: 'assets/models_original/',
  prepared: 'assets/models_prepared/',
  pngMasters: 'assets/images/**/*.png',
  dependencies: 'node_modules/',
  realDatabase: 'tools/ops/telemetry.db*',
  backups: 'tools/ops/backups/',
  maintenance: 'tools/ops/scratch/',
  releasePreviews: 'tools/delivery/releases/',
  privatePem: '*.pem',
  privateKey: '*.key',
  privateP12: '*.p12',
  privatePfx: '*.pfx'
});
const CI_ACTIONS = new Set([
  'actions/checkout@v7', 'actions/setup-node@v7'
]);
const SAFE_CI_COMMANDS = [
  /^npm --prefix tools\/optimize (?:ci --ignore-scripts --no-audit --no-fund|test)$/,
  /^npm --prefix tools\/perf ci --ignore-scripts --no-audit --no-fund$/,
  /^npm pack --dry-run --ignore-scripts$/,
  /^node tools\/optimize\/budget\.mjs$/,
  /^node tools\/vendor\/verify\.mjs$/,
  /^node tools\/p[567]\/check\.mjs --mode native$/,
  /^node tools\/p8\/check\.mjs --mode native$/,
  /^node tools\/p8\/security\.mjs --mode ci$/,
  /^node tools\/p8\/release-dry-run\.mjs$/,
  /^node --test(?: --test-concurrency=\d+)? tools\/p8\/test\/(?:security|headers)\.mjs$/,
  /^node --check (?:src\/(?:engine\/[a-zA-Z0-9_-]+|ui\/[a-zA-Z0-9_-]+|telemetry\/[a-zA-Z0-9_-]+)\.js|packages\/tsl-carpaint\/(?:src\/index|demo\/app)\.js|tools\/p8\/(?:security|test\/(?:security|headers))\.mjs)$/,
  /^node packages\/tsl-carpaint\/test\/gpu\.mjs$/,
  /^node tools\/perf\/gpu_smoke\.mjs$/,
  /^node tools\/p7\/browser_lazy\.mjs$/,
  /^node --version$/,
  /^node -e 'if \(Number\(process\.versions\.node\.split\("\."\)\[0\]\) !== 24\) process\.exit\(1\)'$/,
  /^test -f tools\/p8\/security\.mjs \|\| \{ echo '::error::P8 security gate missing'; exit 1; \}$/,
  /^set -euo pipefail$/,
  /^mkdir -p "\$QA_SHOTS"$/,
  /^python3 -m http\.server \d{2,5} --bind 127\.0\.0\.1 >\/dev\/null 2>&1 &$/,
  /^server=\$!$/,
  /^trap 'kill "\$server" 2>\/dev\/null \|\| true; rm -rf "\$QA_SHOTS"' EXIT$/
];
const SECRET_PATTERNS = Object.freeze({
  privateKeyMaterial: /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH) )?PRIVATE KEY-----/,
  githubToken: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/,
  gitlabToken: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  awsAccessKey: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  stripeLiveSecret: /\bsk_live_[A-Za-z0-9]{20,}\b/,
  openAiSecret: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  googleApiKey: /\bAIza[A-Za-z0-9_-]{35}\b/,
  slackToken: /\bxox[baprs]-[0-9]{9,}-[A-Za-z0-9-]{8,}\b/,
  embeddedDatabaseCredentials: /\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+:[^\s"'@<>]+@[^\s"'<>]+/i
});

function makeViolation(code, path, detail) { return { code, path, detail }; }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function regularRead(root, filename) {
  const segments = filename.split('/');
  if (!segments.length || segments.some(s => !s || s === '.' || s === '..' || s.includes('\\'))) {
    throw new Error('INVALID_PATH: ' + filename);
  }
  let path = root;
  for (let i = 0; i < segments.length; i++) {
    path = join(path, segments[i]);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (i === segments.length - 1 ? !stat.isFile() : !stat.isDirectory()))
      throw new Error('INVALID_SOURCE_TYPE: ' + filename);
  }
  return readFileSync(path);
}
function findSourceLines(workflow) {
  const lines = workflow.split(/\r?\n/);
  const commands = [], uses = [], jobs = [], heredocs = [];
  let inBlock = false, blockIndent = -1;
  let activeHeredoc = null;
  let currentJob = null;
  for (let i = 0; i < lines.length; i++) {
    const full = lines[i], indent = (/^\s*/.exec(full) || [''])[0].length;
    const trim = full.trim();
    if (activeHeredoc) {
      if (trim === activeHeredoc.end) {
        activeHeredoc.complete = true;
        heredocs.push(activeHeredoc);
        activeHeredoc = null;
      } else activeHeredoc.lines.push(trim);
      continue;
    }
    if (!trim || trim.startsWith('#')) continue;
    if (inBlock) {
      if (indent > blockIndent) {
        const cmd = trim.replace(/\s+#.*$/, '').trim();
        if (cmd && !cmd.startsWith('#')) {
          commands.push({ line: i + 1, command: cmd, job: currentJob?.name ?? null });
          const here = /^node --input-type=module <<'([A-Z]+)'$/.exec(cmd);
          if (here) activeHeredoc = { line: i + 1, end: here[1], lines: [], complete: false };
        }
        continue;
      }
      inBlock = false;
    }
    const actualJob = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(full);
    if (actualJob && lines.slice(0, i).some(line => line === 'jobs:')) {
      currentJob = { name: actualJob[1], if: '', runner: '', needs: '' };
      jobs.push(currentJob);
    }
    if (currentJob && /^ {4}if:\s*/.test(full)) currentJob.if = trim.slice(3).trim();
    if (currentJob && /^ {4}runs-on:\s*/.test(full)) currentJob.runner = trim.slice('runs-on:'.length).trim();
    if (currentJob && /^ {4}needs:\s*/.test(full)) currentJob.needs = trim.slice('needs:'.length).trim();
    const use = /^\s*-\s*uses:\s*(\S+)\s*$/.exec(full);
    if (use) uses.push({ line: i + 1, action: use[1] });
    const run = /^\s*(?:-\s*)?run:\s*(.*?)\s*$/.exec(full);
    if (run) {
      if (/^ {6}run:\s*$/.test(full)) continue; // defaults.run: is a mapping, not a shell step
      if (run[1] === '|' || run[1] === '|-' || run[1] === '>') { inBlock = true; blockIndent = indent; }
      else if (run[1]) commands.push({ line: i + 1, command: run[1], job: currentJob?.name ?? null });
      else commands.push({ line: i + 1, command: '(empty run)', job: currentJob?.name ?? null });
    }
  }
  if (activeHeredoc) heredocs.push(activeHeredoc);
  return { commands, uses, jobs, heredocs };
}

// Standalone, dependency-free policy evaluator so tests can supply synthetic
// release and workflow input without mutating actual CI, assets or local DB.
export function inspectSecurity({
  manifest, publicFiles, workflowFiles, gitignore, staging, rights,
  freeStaging = FREE_STAGING_POLICY, consentSource, consentBehaviorPassed = false,
  trackedFiles = [], requireCiInvocation = true, releaseDryRunSource
}) {
  const violations = [], inspected = { publicFiles: 0, firstPartyCodeFiles: 0, workflows: 0, ciCommands: 0 };
  const add = (code, path, detail = '') => violations.push(makeViolation(code, path, detail));
  const entries = Array.isArray(manifest?.files) ? manifest.files : null;
  if (manifest?.format !== 'velance-static-release/1' || !entries?.length) add('INVALID_RELEASE_MANIFEST', '/manifest.json');
  const contents = publicFiles instanceof Map ? publicFiles : new Map();
  const observed = new Set();
  for (const entry of entries || []) {
    inspected.publicFiles++;
    const path = entry?.path;
    if (typeof path !== 'string' || !publicPath(path, { release: true })
      || PRIVATE_RELEASE.test(path)) {
      add('PUBLIC_PATH_NOT_ALLOWED', String(path));
      continue;
    }
    if (observed.has(path)) add('DUPLICATE_RELEASE_PATH', path);
    observed.add(path);
    const bytes = contents.get(path);
    if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(entry.bytes) || entry.bytes !== bytes.length
      || !SHA.test(entry.sha256 || '') || sha(bytes) !== entry.sha256) {
      add('RELEASE_CONTENT_INTEGRITY', path);
      continue;
    }
    if (!CODE_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const text = bytes.toString('utf8');
    const isFirstParty = path === '/index.html' || path.startsWith('/src/')
      || path.startsWith('/styles/') || path.startsWith('/packages/');
    if (isFirstParty) inspected.firstPartyCodeFiles++;
    for (const [rule, pattern] of Object.entries(SECRET_PATTERNS)) {
      if (pattern.test(text)) add('EMBEDDED_SECRET_' + rule, path);
    }
    // Check assignments in authored source only; minified third-party decoders
    // can contain token-like identifiers used by compression parsers.
    if (isFirstParty) {
      const assignment = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret|password)\s*[:=]\s*['"]([^\s'"\\]{16,})['"]/gi;
      if (assignment.test(text)) add('SUSPICIOUS_HARDCODED_CREDENTIAL', path);
      if (path !== '/src/telemetry/collector.js'
        && /(?:fetch|sendBeacon)\s*\(\s*['"]\/api\/telemetry['"]/.test(text))
        add('CONSENT_BYPASS_TELEMETRY_POST', path);
    }
  }
  for (const path of contents.keys()) if (!observed.has(path)) add('UNLISTED_PUBLIC_FILE', path);
  if (!Array.isArray(workflowFiles) || !workflowFiles.length
    || !workflowFiles.some(w => w?.path === '.github/workflows/validate.yml'))
    add('CI_WORKFLOW_MISSING', '.github/workflows/validate.yml');
  let p5 = false, p6 = false, p7 = false, p8 = false, p8Native = false;
  for (const workflow of workflowFiles || []) {
    const name = workflow?.path, source = workflow?.source;
    if (typeof name !== 'string' || !/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(name)
      || typeof source !== 'string') {
      add('INVALID_CI_WORKFLOW', String(name)); continue;
    }
    inspected.workflows++;
    const noComments = source.split(/\r?\n/).filter(line => !line.trim().startsWith('#')).join('\n');
    if (/(?:^|\n)\s*(?:pull_request_target|workflow_run|repository_dispatch|schedule|release):\s*(?:\n|$)/m.test(noComments))
      add('DANGEROUS_CI_EVENT', name);
    if (!/(?:^|\n)permissions:\s*\n\s{2}contents:\s*read\s*(?:\n|$)/.test(noComments)
      || /(?:^|\n)\s*permissions:\s*(?:write-all|read-all)\s*(?:\n|$)/.test(noComments)
      || /(?:^|\n)\s+[a-z-]+:\s*write\s*(?:\n|$)/.test(noComments))
      add('CI_TOKEN_PERMISSIONS', name);
    if (/\$\{\{\s*secrets\./.test(noComments)) add('CI_SECRET_CONTEXT', name);
    if (/^\s+(?:NODE_OPTIONS|BASH_ENV|ENV|GIT_CONFIG_COUNT|NPM_CONFIG_USERCONFIG):/m.test(noComments))
      add('CI_DANGEROUS_ENV', name);
    if (/^\s*continue-on-error:\s*(?:true|\$\{\{)/m.test(noComments))
      add('CI_CONTINUE_ON_ERROR', name);
    if ([...noComments.matchAll(/^\s*shell:\s*(.+)$/gm)]
      .some(match => match[1].replace(/\s+#.*$/, '').trim() !== 'bash'))
      add('CI_UNREVIEWED_SHELL', name);
    if (/^\s*<<:\s*\*/m.test(noComments)) add('CI_YAML_MERGE_UNREVIEWED', name);
    if (/(?:^|\n)\s*-\s*uses:\s*[^#\n]*(?:\$\{\{|\b(?:latest|main|master)\b)/.test(noComments))
      add('UNPINNED_OR_DYNAMIC_CI_ACTION', name);
    const parsed = findSourceLines(source);
    for (const use of parsed.uses) {
      if (!CI_ACTIONS.has(use.action)) add('CI_ACTION_UNREVIEWED', name + ':' + use.line, use.action);
      const later = source.split(/\r?\n/).slice(use.line);
      const subsequent = [];
      for (const line of later) {
        if (/^\s*-\s*(?:name|uses):/.test(line) || /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) break;
        subsequent.push(line);
      }
      const properties = subsequent.join('\n');
      if (use.action === 'actions/checkout@v7' && !/^\s+persist-credentials:\s*false\s*$/m.test(properties))
        add('CI_CHECKOUT_PERSISTS_CREDENTIALS', name + ':' + use.line);
      if (use.action === 'actions/setup-node@v7' && !/^\s+package-manager-cache:\s*false\s*$/m.test(properties))
        add('CI_NODE_CACHE_UNREVIEWED', name + ':' + use.line);
    }
    for (const job of parsed.jobs) {
      if (/\bself-hosted\b/.test(job.runner)
        && (!/^github\.event_name == 'workflow_dispatch' && inputs\.gpu(?: == true)?$/.test(job.if)
          || job.name !== 'gpu' || job.needs !== 'validate')) {
        add('UNTRUSTED_SELF_HOSTED_RUNNER', name, job.name);
      }
    }
    for (const heredoc of parsed.heredocs) {
      add('CI_INLINE_SCRIPT_UNREVIEWED', name + ':' + heredoc.line,
        heredoc.complete ? 'Run a reviewed local script file instead of embedding executable code' : 'Unterminated inline script');
    }
    if (name === '.github/workflows/validate.yml'
      && parsed.commands.some(item => item.command === 'node tools/p8/release-dry-run.mjs')
      && !/^\s*- name:[^\n]*\n\s*if:\s*github\.event_name == 'workflow_dispatch' && inputs\.release_dry_run == true\n\s*run:\s*node tools\/p8\/release-dry-run\.mjs\s*$/m.test(source))
      add('UNGUARDED_RELEASE_DRY_RUN', name);
    for (const command of parsed.commands) {
      inspected.ciCommands++;
      if (/\$\{\{/.test(command.command) || !SAFE_CI_COMMANDS.some(rule => rule.test(command.command)))
        add('CI_COMMAND_UNREVIEWED', name + ':' + command.line, command.command);
      if (command.command === 'node tools/p7/browser_lazy.mjs'
        && !(command.job === 'gpu' && parsed.jobs.some(job => job.name === 'gpu'
          && /^github\.event_name == 'workflow_dispatch' && inputs\.gpu(?: == true)?$/.test(job.if)
          && /\bself-hosted\b/.test(job.runner))))
        add('CI_GPU_BROWSER_NOT_MANUAL', name + ':' + command.line, command.command);
      if (name === '.github/workflows/validate.yml') {
        p5 ||= command.command === 'node tools/p5/check.mjs --mode native';
        p6 ||= command.command === 'node tools/p6/check.mjs --mode native';
        p7 ||= command.command === 'node tools/p7/check.mjs --mode native';
        p8 ||= command.command === 'node tools/p8/security.mjs --mode ci';
        p8Native ||= command.command === 'node tools/p8/check.mjs --mode native'
          || /^node --test(?: --test-concurrency=\d+)? tools\/p8\/test\/(?:security|headers)\.mjs$/.test(command.command);
      }
    }
  }
  for (const [name, present] of Object.entries({ p5, p6, p7, ...(requireCiInvocation ? { p8, p8Native } : {}) })) {
    if (!present) add('CI_REQUIRED_GATE_MISSING', '.github/workflows/validate.yml', name);
  }
  const rules = new Set(typeof gitignore === 'string'
    ? gitignore.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#')) : []);
  for (const [name, rule] of Object.entries(IGNORED_REQUIRED)) {
    if (!rules.has(rule)) add('GITIGNORE_PROTECTION_MISSING', '.gitignore', name + ': ' + rule);
  }
  if (!rules.has('.env*') && !(rules.has('.env') && rules.has('.env.*')))
    add('GITIGNORE_PROTECTION_MISSING', '.gitignore', 'envFiles: .env* or (.env and .env.*)');
  for (const path of trackedFiles) if (SENSITIVE_FILE.test(path)
    || /^(?:assets\/models_original\/|assets\/models_prepared\/|tools\/ops\/backups\/|tools\/delivery\/releases\/)/.test(path))
    add('TRACKED_PRIVATE_ASSET', path);
  if (staging?.format !== 'velance-p6-private-staging/1'
    || staging?.deployEnabled !== false || staging?.publicLaunchAuthorized !== false
    || staging?.origin?.publicRead !== false || staging?.origin?.publicList !== false
    || staging?.edge?.denyByDefault !== true || staging?.edge?.telemetry?.enabled !== false
    || staging?.edge?.telemetry?.explicitOptInRequired !== true
    || staging?.privateServices?.bind !== '127.0.0.1')
    add('PUBLIC_STAGING_GATE_OPEN', 'config/p6/private-staging.json');
  if (freeStaging?.costVnd !== 0 || freeStaging?.cloud !== false
    || freeStaging?.upstream !== null || freeStaging?.networkBinding !== '127.0.0.1'
    || freeStaging?.publicLaunchAuthorized !== false || freeStaging?.licensedAssetsForPublicUse !== false)
    add('FREE_STAGING_EXPOSURE', 'tools/p7/free-staging.mjs');
  if (rights?.localAudit !== 'PASS_LOCAL' || rights?.publicLaunch !== 'NO_GO'
    || rights?.g0LegalGate !== 'BLOCKED' || rights?.legalDistributionAuthorizedByAudit !== false
    || rights?.registeredRights?.total !== 96 || rights?.registeredRights?.legalSignaturesIndependentlyVerified !== 0)
    add('AUTOMATIC_LEGAL_APPROVAL_RISK', 'docs/p5-asset-rights-register.json');
  if (typeof consentSource !== 'string'
    || !/\blet consentGranted\s*=\s*false\b/.test(consentSource)
    || !/record\?\.decision === 'granted'/.test(consentSource)
    || !/if \(!consentGranted \|\| forcedOff\) return/.test(consentSource)
    || !/if \(consentGranted\) void activate\(\)/.test(consentSource)
    || !/setConsent\(false\)/.test(consentSource)
    || !/setConsent\(true\)/.test(consentSource)
    || !/velance_telemetry_consent_v1/.test(consentSource))
    add('TELEMETRY_OPT_IN_SOURCE_GUARD', 'src/telemetry/collector.js');
  if (consentBehaviorPassed !== true)
    add('TELEMETRY_OPT_IN_TEST_REQUIRED', 'tools/p7/test/consent.mjs');
  if (typeof releaseDryRunSource !== 'string'
    || sha(Buffer.from(releaseDryRunSource)) !== REVIEWED_LOCAL_DRY_RUN_SHA256)
    add('CI_RELEASE_DRY_RUN_SOURCE_CHANGED', 'tools/p8/release-dry-run.mjs',
      'Manual release script must be independently reviewed before updating the expected SHA-256.');
  return {
    format: 'velance-p8-security-policy/1',
    localSecurity: violations.length ? 'FAIL_CLOSED' : 'PASS_LOCAL',
    ...LEGAL_EXIT,
    ciNoDeployPolicy: violations.some(v => v.code.startsWith('CI_')
      || v.code.startsWith('DANGEROUS_')
      || v.code === 'UNTRUSTED_SELF_HOSTED_RUNNER') ? 'BLOCKED' : 'VERIFIED_LOCAL',
    telemetryConsentGate: violations.some(v => v.code.startsWith('TELEMETRY_')) ? 'BLOCKED' : 'VERIFIED_LOCAL',
    immutableReleaseSourceScan: violations.some(v => v.code.startsWith('PUBLIC_')
      || v.code.startsWith('RELEASE_') || v.code.startsWith('EMBEDDED_')
      || v.code.includes('HARDCODED') || v.code === 'UNLISTED_PUBLIC_FILE') ? 'BLOCKED' : 'VERIFIED_LOCAL',
    inspected, violations
  };
}

function readWorkflows(root) {
  const folder = join(root, '.github/workflows');
  const entries = readdirSync(folder, { withFileTypes: true });
  return entries.filter(e => /\.ya?ml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name)).map(e => {
    if (!e.isFile() || e.isSymbolicLink()) throw new Error('CI_FILE_NOT_REGULAR: ' + e.name);
    return { path: '.github/workflows/' + e.name,
      source: regularRead(root, '.github/workflows/' + e.name).toString('utf8') };
  });
}
function gitTrackedPrivate(root) {
  const found = spawnSync('git', ['ls-files', '-z', '--cached'], {
    cwd: root, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024
  });
  if (found.status !== 0 || found.error) throw found.error || new Error('GIT_TRACKED_INVENTORY_FAILED');
  return found.stdout.toString('utf8').split('\0').filter(Boolean);
}
export async function auditSecurity(root = ROOT, { mode = 'ci' } = {}) {
  if (!['ci', 'native'].includes(mode)) throw new Error('MODE_MUST_BE_CI_OR_NATIVE');
  const temp = mkdtempSync(join(tmpdir(), 'velance-p8-security-'));
  try {
    const snapshot = await createSnapshot({ sourceRoot: root, storeDir: temp });
    const release = await verifySnapshot({ storeDir: temp, id: snapshot.id });
    const register = JSON.parse(regularRead(root, 'docs/p5-asset-rights-register.json').toString('utf8'));
    const modelManifest = JSON.parse(regularRead(root, 'assets/models/manifest.json').toString('utf8'));
    const rights = auditRights({ root, release, register, modelManifest });
    const staging = JSON.parse(regularRead(root, 'config/p6/private-staging.json').toString('utf8'));
    try { validateStagingContract(staging); }
    catch (error) { throw Object.assign(new Error('P6_STAGING_CONTRACT_FAILED: ' + error.message),
      { code: 'P6_STAGING_CONTRACT_FAILED' }); }
    const test = spawnSync(process.execPath,
      ['--test', 'tools/p7/test/consent.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    if (test.error) throw test.error;
    const match = /ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(test.stdout || '');
    const consentBehaviorPassed = test.status === 0 && match && Number(match[1]) >= 8
      && Number(match[2]) === Number(match[1]) && Number(match[3]) === 0;
    const publicFiles = new Map(release.manifest.files.map(entry =>
      [entry.path, regularRead(release.root, entry.path.slice(1))]));
    const report = inspectSecurity({
      manifest: release.manifest, publicFiles, workflowFiles: readWorkflows(root),
      gitignore: regularRead(root, '.gitignore').toString('utf8'),
      staging, rights, consentSource: regularRead(root, 'src/telemetry/collector.js').toString('utf8'),
      consentBehaviorPassed, trackedFiles: gitTrackedPrivate(root),
      releaseDryRunSource: regularRead(root, 'tools/p8/release-dry-run.mjs').toString('utf8')
    });
    report.mode = mode;
    report.node = process.version;
    report.releaseId = release.id;
    report.releaseManifestFiles = release.manifest.files.length;
    report.rights = {
      approved: rights.registeredRights.claimedApproved,
      unverified: rights.registeredRights.unverified,
      additionalRightsNeeded: rights.publicRightsScope.additionalRightsNeeded,
      g0: 'BLOCKED'
    };
    report.consentTests = {
      passed: consentBehaviorPassed,
      count: match ? Number(match[1]) : null,
      failed: match ? Number(match[3]) : null
    };
    report.providerVerified = false;
    report.publicDeploymentPerformed = false;
    report.assessedAtUtc = new Date().toISOString();
    return report;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--mode'
      || !['ci', 'native'].includes(args[1])))
      throw Object.assign(new Error('Usage: node tools/p8/security.mjs [--mode ci|native]'), { code: 'USAGE' });
    if (Number(process.versions.node.split('.')[0]) < 24)
      throw Object.assign(new Error('Node 24+ required'), { code: 'NODE_VERSION' });
    const result = await auditSecurity(ROOT, { mode: args[1] || 'ci' });
    console.log(JSON.stringify(result, null, 2));
    if (result.localSecurity !== 'PASS_LOCAL') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ format: 'velance-p8-security-policy/1', localSecurity: 'FAIL_CLOSED',
      ...LEGAL_EXIT, errorCode: error.code || 'AUDIT_FAILED', error: error.message }));
    process.exitCode = 1;
  }
}
