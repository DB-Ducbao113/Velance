// VELANCE P5 handoff and public-launch gap assessment. No deployment side effects.
// Outputs local acceptance AND public blockers separately; never equates a valid
// GLB checksum with a license or a localhost benchmark with production readiness.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshot } from '../delivery/release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--out' && args[1] && !args[1].startsWith('--'),
  'Usage: node tools/p5/readiness.mjs --out tools/perf/results/p5-public-readiness.json');
const out = resolve(ROOT, args[1]);
assert(!existsSync(out), 'Refusing to overwrite prior readiness evidence: ' + out);
const parse = path => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const p4 = parse('tools/perf/results/p4-extended-acceptance.json');
const handoff = parse('tools/perf/results/p5-handoff-evidence.json');
const register = parse('docs/p5-asset-rights-register.json');
const virtual = parse('tools/perf/results/p4-real-asset-virtual-10-25-50-100.json');
const webgpu = parse('tools/perf/results/p4-multitab-webgpu-4.json');
const webgl = parse('tools/perf/results/p4-multitab-webgl2-4.json');
assert.equal(p4.result, 'PASS_LOCAL', 'P4 source-of-truth failed');
assert.equal(handoff.sourceMatchesAcceptedRelease, true, 'P5 current source was not fingerprint-verified');
assert.equal(handoff.releaseId, virtual.assets?.releasedId, 'P5 and real HTTP users tested different releases');
assert.equal(handoff.releaseId, webgpu.release?.id, 'P5 and WebGPU browsers tested different releases');
assert.equal(handoff.releaseId, webgl.release?.id, 'P5 and WebGL2 browsers tested different releases');
const currentTemp = mkdtempSync(join(tmpdir(), 'velance-p5-readiness-'));
try {
  const current = await createSnapshot({ sourceRoot: ROOT, storeDir: currentTemp });
  assert.equal(current.id, handoff.releaseId, 'Current public source differs from P4-tested release');
} finally { rmSync(currentTemp, { recursive: true, force: true }); }
assert.equal(register.entries.length, 96, 'Rights inventory is incomplete');
assert.equal(register.entries.filter(x => x.kind === 'prepared_3d_model').length, 16);
assert.equal(register.entries.filter(x => x.kind === 'derived_editorial_render').length, 80);
const seen = new Set(), invalidIdentity = [], legal = { approved: 0, unverified: 0, invalidApproval: 0 };
for (const entry of register.entries) {
  assert(typeof entry.path === 'string' && /^\/assets\/(?:models\/[^/]+\.glb|images\/[^/]+\/[^/]+\.webp)$/.test(entry.path),
    'Unexpected path in rights register');
  assert(!seen.has(entry.path), 'Duplicate asset rights entry');
  seen.add(entry.path);
  const file = join(ROOT, entry.path.slice(1)), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Asset path is not a regular file: ' + entry.path);
  const bytes = readFileSync(file);
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
    invalidIdentity.push(entry.path);
  if (entry.approvalStatus !== 'APPROVED') {
    legal.unverified++;
    continue;
  }
  // This checks metadata completeness only. Human/legal review must still
  // assess the authenticity of the evidence before public publication.
  const metadataComplete = !!(entry.authorOrOwner && entry.originalSourceUrl && entry.originalSourceProof
    && entry.licenseName && entry.exactLicenseUrl && entry.rightsEvidenceFile
    && entry.reviewer && entry.reviewedAtUtc && entry.independentProvenanceChecked === true
    && entry.permitsCommercialWebsite === true
    && (entry.kind === 'prepared_3d_model'
      ? entry.permitsModification === true && entry.permitsModelConversion === true
        && entry.permitsSelfHostedWebGLDistribution === true
      : entry.permitsRenderDerivativeDistribution === true));
  if (metadataComplete) legal.approved++;
  else legal.invalidApproval++;
}
assert.equal(invalidIdentity.length, 0, 'Rights register no longer matches current asset bytes');
const publicRequirements = {
  licenseProvenance: legal.approved === 96 && legal.invalidApproval === 0 ? 'NEEDS_INDEPENDENT_SIGNOFF' : 'BLOCKED',
  immutableCDNAndPrivateObjectOrigin: 'NOT_CONFIGURED',
  domainTLSAndHTTPSSecurityHeaders: 'NOT_CONFIGURED',
  edgeAbuseControlsAndTelemetryRateRules: 'NOT_CONFIGURED',
  privateReadApiOpsSSOAndLeastPrivilege: 'NOT_CONFIGURED',
  telemetryConsentPrivacyNoticeRetention: 'NOT_CONFIGURED',
  encryptedOffHostBackupsAndRestoreDrill: 'NOT_CONFIGURED',
  externalMonitoringAlertDeliveryAndOnCall: 'NOT_CONFIGURED',
  realMultiRegionProductionLoadAnd24hSoak: 'NOT_VERIFIED',
  productionReleaseCanaryAndRollback: 'NOT_VERIFIED',
  accountableOperatorAndLaunchApproval: 'UNASSIGNED'
};
const docs = ['docs/p5-system-design.md', 'docs/p5-operations.md',
  'docs/p5-capacity-cost.md', 'docs/p5-public-launch-checklist.md'];
const missingDocs = docs.filter(file => !existsSync(join(ROOT, file)));
const report = {
  format: 'velance-p5-readiness/1',
  assessedAtUtc: new Date().toISOString(),
  localHandoff: missingDocs.length === 0 ? 'PASS_LOCAL' : 'DOCUMENTS_INCOMPLETE',
  documentedP4Evidence: 'PASS_LOCAL',
  sourceAssetDigestIdentity: 'VERIFIED',
  publicLaunch: 'BLOCKED',
  internetDeploymentAuthorized: false,
  sourceReleaseId: handoff.releaseId,
  rights: { ...legal, total: register.entries.length,
    checksumMismatch: invalidIdentity.length, template: 'docs/p5-asset-rights-register.json',
    note: 'All 96 rights entries require evidence, individual review and independent legal signoff; a hash is not a license.' },
  publicRequirements,
  missingHandoffDocs: missingDocs,
  boundaries: ['Local HTTP and Apple M5 GPU evidence only',
    '100 virtual HTTP clients used a global maximum of 16 simultaneous file downloads',
    'Four real Chrome tabs share one GPU rather than four independent client devices',
    'No public CDN/Internet, private identity system, licensed materials, or offsite recovery has been deployed']
};
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
