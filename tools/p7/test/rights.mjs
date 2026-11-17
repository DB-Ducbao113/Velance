import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { createSnapshot, verifySnapshot } from '../../delivery/release.mjs';
import { auditRights } from '../rights.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const put = (root, name, bytes) => {
  const file = join(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return { path: '/' + name, bytes: bytes.length, sha256: digest(bytes) };
};
const RIGHTS_FIELDS = {
  authorOrOwner: null, originalSourceUrl: null, originalSourceProof: null,
  licenseName: null, exactLicenseUrl: null, permitsModification: null,
  permitsModelConversion: null, permitsSelfHostedWebGLDistribution: null,
  permitsCommercialWebsite: null, permitsRenderDerivativeDistribution: null,
  attributionRequired: null, requiredAttributionText: null,
  independentProvenanceChecked: null, rightsEvidenceFile: null,
  reviewer: null, reviewedAtUtc: null, approvalStatus: 'UNVERIFIED'
};
let temp, root, release, register, modelManifest;
function parameters(changes = {}) {
  return { root, release, register, modelManifest, ...changes };
}
function clone() { return structuredClone(register); }
function expectFailure(code, changes = {}) {
  assert.throws(() => auditRights(parameters(changes)), error => error?.code === code);
}

before(async () => {
  temp = mkdtempSync(join(tmpdir(), 'velance-p7-test-'));
  root = join(temp, 'fixture');
  const modelEntries = [], rightsEntries = [];
  put(root, 'index.html', Buffer.from('<html><body>synthetic-only</body></html>'));
  for (let i = 0; i < 16; i++) {
    const name = 'fixture-' + String(i).padStart(2, '0');
    const model = put(root, 'assets/models/' + name + '.glb',
      Buffer.from('synthetic-model-' + name));
    modelEntries.push({ file: name + '.glb', bytes: model.bytes, sha256: model.sha256 });
    rightsEntries.push({ ...model, kind: 'prepared_3d_model', ...RIGHTS_FIELDS });
    for (let frame = 0; frame < 5; frame++) {
      const render = put(root, 'assets/images/' + name + '/frame-' + frame + '.webp',
        Buffer.from('synthetic-render-' + name + '-' + frame));
      rightsEntries.push({ ...render, kind: 'derived_editorial_render',
        carAlbum: name, ...RIGHTS_FIELDS });
    }
  }
  put(root, 'assets/environment/studio-mobile.webp', Buffer.from('original-fixture-environment-mobile'));
  put(root, 'assets/environment/studio-desktop.webp', Buffer.from('original-fixture-environment-desktop'));
  put(root, 'assets/images/fixture-00/master.png', Buffer.from('private-fixture-master'));
  put(root, 'assets/models_original/original.glb', Buffer.from('private-fixture-model'));
  modelManifest = { entries: modelEntries };
  register = { format: 'velance-p5-asset-rights-register/1', publicUseAllowed: false,
    counts: { models: 16, webpRenders: 80, total: 96, unverified: 96, approved: 0 },
    entries: rightsEntries };
  const snapshot = await createSnapshot({ sourceRoot: root, storeDir: join(temp, 'store') });
  release = await verifySnapshot({ storeDir: join(temp, 'store'), id: snapshot.id });
});
after(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

test('16+80 exact synthetic fixture is PASS_LOCAL while rights remain 0/96 NO_GO', () => {
  const report = auditRights(parameters({ historicalP4ReleaseId: release.id }));
  assert.equal(report.localAudit, 'PASS_LOCAL');
  assert.equal(report.publicLaunch, 'NO_GO');
  assert.equal(report.g0LegalGate, 'BLOCKED');
  assert.equal(report.legalDistributionAuthorizedByAudit, false);
  assert.deepEqual({ models: report.registeredRights.models, renders: report.registeredRights.webpRenders,
    approved: report.registeredRights.claimedApproved, unverified: report.registeredRights.unverified },
  { models: 16, renders: 80, approved: 0, unverified: 96 });
  assert.equal(report.sourceRelease.matchesHistoricalP4Release, true);
  assert.equal(report.publicRightsScope.mediaFiles, 98);
  assert.deepEqual(report.publicRightsScope.additionalRightsNeeded,
    ['/assets/environment/studio-desktop.webp', '/assets/environment/studio-mobile.webp']);
  assert.equal(report.excludedSourceMedia.count, 2);
});

test('rights identity drift fails on GLB and WebP, even if files still exist', () => {
  for (const index of [0, 1, 95]) {
    const broken = clone();
    broken.entries[index].sha256 = 'f'.repeat(64);
    expectFailure('RIGHTS_RELEASE_SHA_MISMATCH', { register: broken });
  }
});

test('reject claimed APPROVED without provenance instead of treating a flag as permission', () => {
  const forged = clone();
  forged.entries[0].approvalStatus = 'APPROVED';
  forged.counts.approved = 1;
  forged.counts.unverified = 95;
  expectFailure('UNSUPPORTED_APPROVAL_MISSING_EVIDENCE', { register: forged });
});

test('even fully populated self-reported APPROVED remains unverified by independent legal authority', () => {
  const claimed = clone();
  const item = claimed.entries[0];
  item.approvalStatus = 'APPROVED';
  for (const key of ['authorOrOwner', 'originalSourceUrl', 'originalSourceProof',
    'licenseName', 'exactLicenseUrl', 'rightsEvidenceFile', 'reviewer']) item[key] = 'synthetic ' + key;
  item.reviewedAtUtc = '2026-11-01T00:00:00.000Z';
  item.permitsModification = true;
  item.permitsModelConversion = true;
  item.permitsSelfHostedWebGLDistribution = true;
  item.permitsCommercialWebsite = true;
  item.independentProvenanceChecked = true;
  item.attributionRequired = false;
  claimed.counts.approved = 1;
  claimed.counts.unverified = 95;
  expectFailure('UNSUPPORTED_APPROVAL_MISSING_EVIDENCE', { register: claimed });
  put(root, 'docs/rights/synthetic-evidence.txt', Buffer.from('fixture-only, not a legal authorization'));
  item.rightsEvidenceFile = 'docs/rights/synthetic-evidence.txt';
  const report = auditRights(parameters({ register: claimed }));
  assert.equal(report.registeredRights.claimedApproved, 1);
  assert.equal(report.registeredRights.legalSignaturesIndependentlyVerified, 0);
  assert.equal(report.publicLaunch, 'NO_GO');
  assert.equal(report.g0LegalGate, 'BLOCKED');
});

test('missing, duplicate, wrongly categorized paths and invalid counts fail closed', () => {
  const missing = clone();
  missing.entries.pop();
  expectFailure('RIGHTS_COUNT_MISMATCH', { register: missing });
  const duplicate = clone();
  duplicate.entries[1] = structuredClone(duplicate.entries[0]);
  expectFailure('DUPLICATE_OR_MISCLASSIFIED_RIGHT', { register: duplicate });
  const traversal = clone();
  traversal.entries[0].path = '/assets/models/../outside.glb';
  expectFailure('INVALID_RIGHTS_ENTRY', { register: traversal });
  const badAlbum = clone();
  badAlbum.entries[1].carAlbum = 'other';
  expectFailure('RENDER_ALBUM_MISMATCH', { register: badAlbum });
  const badCounts = clone();
  badCounts.counts.unverified = 95;
  expectFailure('RIGHTS_DECLARED_COUNT_MISMATCH', { register: badCounts });
});

test('source metadata or immutable manifest mutation fails the SHA gate', () => {
  const invalid = structuredClone(modelManifest);
  invalid.entries[0].sha256 = '0'.repeat(64);
  expectFailure('SOURCE_MODEL_SHA_MISMATCH', { modelManifest: invalid });
  const changedRelease = structuredClone(release);
  changedRelease.manifest.files[0].sha256 = '0'.repeat(64);
  expectFailure('INVALID_IMMUTABLE_RELEASE', { release: changedRelease });
});

test('unexpected public media after snapshot is detected, private masters are not published', () => {
  put(root, 'assets/environment/third-party.webp', Buffer.from('another fixture'));
  try { expectFailure('PUBLIC_MEDIA_RELEASE_INVENTORY_MISMATCH'); }
  finally { rmSync(join(root, 'assets/environment/third-party.webp')); }
  const report = auditRights(parameters());
  assert.equal(report.excludedSourceMedia.byExtension['.png'], 1);
  assert.equal(report.excludedSourceMedia.byExtension['.glb'], 1);
});

test('source byte mutation after immutable snapshot is detected, including non-asset public code', () => {
  const file = join(root, 'index.html');
  const original = readFileSync(file);
  writeFileSync(file, Buffer.from('<html><body>tampered</body></html>'));
  try { expectFailure('RELEASE_SOURCE_SHA_MISMATCH'); }
  finally { writeFileSync(file, original); }
});

test('a symlink placed in a public asset tree is rejected', () => {
  const file = join(root, 'assets/environment/external.webp');
  symlinkSync(join(root, 'index.html'), file);
  try { expectFailure('ASSET_TREE_SYMLINK'); }
  finally { rmSync(file); }
});
