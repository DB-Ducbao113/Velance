// P7: exact local public-asset identity and provenance inventory.
// PASS_LOCAL checks bytes and completeness of the audit, never legal permission.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshot, verifySnapshot } from '../delivery/release.mjs';
import { publicPath } from '../delivery/static.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HASH = /^[a-f0-9]{64}$/;
const PUBLIC_MODEL = /^\/assets\/models\/[^/]+\.glb$/;
const PUBLIC_RENDER = /^\/assets\/images\/[^/]+\/[^/]+\.webp$/;
const MEDIA = new Set(['.glb', '.gltf', '.webp', '.png', '.jpg', '.jpeg', '.avif',
  '.svg', '.hdr', '.exr', '.ktx2', '.mp4', '.webm', '.gif', '.woff', '.woff2', '.ttf', '.otf']);
const REVIEW_FIELDS = ['authorOrOwner', 'originalSourceUrl', 'originalSourceProof',
  'licenseName', 'exactLicenseUrl', 'rightsEvidenceFile', 'reviewer', 'reviewedAtUtc'];

function fail(code, path = '') {
  const error = new Error(code + (path ? ': ' + path : ''));
  error.code = code;
  throw error;
}
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function stablePath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')
    && !path.includes('\\') && !path.includes('%') && !/[\0-\x1f\x7f]/.test(path)
    && path.slice(1).split('/').every(segment => segment && segment !== '.' && segment !== '..');
}
function fileBytes(root, path) {
  if (!stablePath(path)) fail('INVALID_ASSET_PATH', String(path));
  const segments = path.slice(1).split('/');
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    current = join(current, segment);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') fail('ASSET_MISSING', path);
      throw error;
    }
    if (stat.isSymbolicLink()) fail('ASSET_SYMLINK', path);
    if (index < segments.length - 1 && !stat.isDirectory())
      fail('ASSET_PARENT_INVALID', path);
  }
  if (!lstatSync(current).isFile()) fail('ASSET_NOT_REGULAR', path);
  return readFileSync(current);
}
function checkEntry(entry, label) {
  if (!plain(entry) || !stablePath(entry.path) || !Number.isSafeInteger(entry.bytes)
    || entry.bytes < 0 || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256))
    fail('INVALID_' + label, JSON.stringify(entry?.path ?? null));
}
function verifyContents(root, entry, label) {
  const buffer = fileBytes(root, entry.path);
  if (buffer.length !== entry.bytes || sha(buffer) !== entry.sha256)
    fail(label + '_SHA_MISMATCH', entry.path);
}
function treeFiles(root, directory, collected) {
  const folder = join(root, directory);
  if (!existsSync(folder)) return;
  if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink())
    fail('ASSET_TREE_INVALID', '/' + directory);
  for (const child of readdirSync(folder, { withFileTypes: true })) {
    if (child.name.startsWith('.')) continue;
    const rel = directory + '/' + child.name, path = '/' + rel;
    if (child.isSymbolicLink()) fail('ASSET_TREE_SYMLINK', path);
    if (child.isDirectory()) treeFiles(root, rel, collected);
    else if (child.isFile() && MEDIA.has(extname(child.name).toLowerCase())) collected.push(path);
    else if (!child.isFile()) fail('ASSET_TREE_INVALID', path);
  }
}
function missingProvenance(entry, root) {
  const missing = REVIEW_FIELDS.filter(field => typeof entry[field] !== 'string' || !entry[field].trim());
  if (typeof entry.rightsEvidenceFile === 'string' && entry.rightsEvidenceFile.trim()) {
    const evidencePath = entry.rightsEvidenceFile;
    if (!/^docs\/[^/]+/.test(evidencePath)
      || !stablePath('/' + evidencePath)) missing.push('localEvidenceReadable');
    else {
      try {
        if (fileBytes(root, '/' + evidencePath).length === 0) missing.push('localEvidenceReadable');
      } catch { missing.push('localEvidenceReadable'); }
    }
  }
  for (const field of ['permitsCommercialWebsite', 'independentProvenanceChecked']) {
    if (entry[field] !== true) missing.push(field);
  }
  if (entry.kind === 'prepared_3d_model') {
    for (const field of ['permitsModification', 'permitsModelConversion', 'permitsSelfHostedWebGLDistribution'])
      if (entry[field] !== true) missing.push(field);
  } else if (entry.permitsRenderDerivativeDistribution !== true) {
    missing.push('permitsRenderDerivativeDistribution');
  }
  if (entry.attributionRequired !== true && entry.attributionRequired !== false)
    missing.push('attributionRequired');
  if (entry.attributionRequired === true && (!entry.requiredAttributionText || !String(entry.requiredAttributionText).trim()))
    missing.push('requiredAttributionText');
  if (entry.reviewer && (!Number.isFinite(Date.parse(entry.reviewedAtUtc)) || new Date(entry.reviewedAtUtc).toISOString() !== entry.reviewedAtUtc))
    missing.push('validReviewedAtUtc');
  return missing;
}

// Publicly callable audit allows fixture tests without touching the real repository.
// release must be a byte-verified immutable snapshot (verifySnapshot before calling).
export function auditRights({ root, register, release, modelManifest, historicalP4ReleaseId = null }) {
  root = resolve(root);
  if (!plain(register) || register.format !== 'velance-p5-asset-rights-register/1'
    || register.publicUseAllowed !== false || !Array.isArray(register.entries))
    fail('INVALID_RIGHTS_REGISTER');
  if (!plain(release) || !HASH.test(release.id) || !plain(release.manifest)
    || release.manifest.format !== 'velance-static-release/1' || !Array.isArray(release.manifest.files)
    || !release.manifest.files.length
    || sha(JSON.stringify(release.manifest)) !== release.id)
    fail('INVALID_IMMUTABLE_RELEASE');
  const releaseFiles = new Map();
  let previous = '';
  for (const item of release.manifest.files) {
    checkEntry(item, 'RELEASE_ENTRY');
    if (!publicPath(item.path, { release: true }) || item.path <= previous || releaseFiles.has(item.path))
      fail('INVALID_RELEASE_PATH_ORDER', item.path);
    previous = item.path;
    releaseFiles.set(item.path, item);
    verifyContents(root, item, 'RELEASE_SOURCE');
  }
  if (!plain(modelManifest) || !Array.isArray(modelManifest.entries)
    || modelManifest.entries.length !== 16) fail('INVALID_MODEL_MANIFEST');
  const models = new Map();
  for (const item of modelManifest.entries) {
    if (!plain(item) || typeof item.file !== 'string' || !/^[^/\\]+\.glb$/.test(item.file)
      || !Number.isSafeInteger(item.bytes) || !HASH.test(item.sha256) || models.has(item.file))
      fail('INVALID_MODEL_METADATA', String(item?.file));
    models.set(item.file, item);
  }
  if (register.entries.length !== 96) fail('RIGHTS_COUNT_MISMATCH');
  const byPath = new Map();
  const status = { unverified: 0, claimedApproved: 0, rejected: 0 };
  const evidenceGaps = {};
  for (const item of register.entries) {
    checkEntry(item, 'RIGHTS_ENTRY');
    if (!PUBLIC_MODEL.test(item.path) && !PUBLIC_RENDER.test(item.path))
      fail('INVALID_RIGHTS_PATH', item.path);
    const kind = PUBLIC_MODEL.test(item.path) ? 'prepared_3d_model' : 'derived_editorial_render';
    if (item.kind !== kind || byPath.has(item.path)) fail('DUPLICATE_OR_MISCLASSIFIED_RIGHT', item.path);
    byPath.set(item.path, item);
    const source = releaseFiles.get(item.path);
    if (!source || source.bytes !== item.bytes || source.sha256 !== item.sha256)
      fail('RIGHTS_RELEASE_SHA_MISMATCH', item.path);
    if (kind === 'prepared_3d_model') {
      const model = models.get(item.path.split('/').at(-1));
      if (!model || model.bytes !== item.bytes || model.sha256 !== item.sha256)
        fail('SOURCE_MODEL_SHA_MISMATCH', item.path);
    } else if (item.carAlbum !== item.path.split('/')[3]) {
      fail('RENDER_ALBUM_MISMATCH', item.path);
    }
    if (item.approvalStatus === 'UNVERIFIED') status.unverified++;
    else if (item.approvalStatus === 'REJECTED') status.rejected++;
    else if (item.approvalStatus === 'APPROVED') {
      const missing = missingProvenance(item, root);
      if (missing.length) fail('UNSUPPORTED_APPROVAL_MISSING_EVIDENCE', item.path + ' ' + missing.join(','));
      // Metadata can be present, but this machine cannot authenticate legal signatures.
      status.claimedApproved++;
    } else fail('UNKNOWN_RIGHTS_STATUS', item.path);
    for (const missing of missingProvenance(item, root)) evidenceGaps[missing] = (evidenceGaps[missing] || 0) + 1;
  }
  const registeredModels = [...byPath.keys()].filter(path => PUBLIC_MODEL.test(path));
  const registeredRenders = [...byPath.keys()].filter(path => PUBLIC_RENDER.test(path));
  if (registeredModels.length !== 16 || registeredRenders.length !== 80)
    fail('RIGHTS_KIND_COUNT_MISMATCH');
  if (models.size !== registeredModels.length || [...models.keys()].some(file => !byPath.has('/assets/models/' + file)))
    fail('MODEL_INVENTORY_MISMATCH');
  const albums = new Map();
  for (const path of registeredRenders) {
    const album = path.split('/')[3];
    albums.set(album, (albums.get(album) || 0) + 1);
  }
  if (albums.size !== 16 || [...albums.values()].some(count => count !== 5))
    fail('RENDER_ALBUM_INVENTORY_MISMATCH');

  const sourceMedia = [];
  for (const top of ['assets', 'src', 'styles', 'vendor', 'packages']) treeFiles(root, top, sourceMedia);
  const publicMedia = sourceMedia.filter(path => publicPath(path, { release: true }));
  const releasedMedia = [...releaseFiles.keys()].filter(path => MEDIA.has(extname(path).toLowerCase()));
  if (publicMedia.some(path => !releaseFiles.has(path)) || releasedMedia.some(path => !publicMedia.includes(path)))
    fail('PUBLIC_MEDIA_RELEASE_INVENTORY_MISMATCH');
  const registeredPublicPaths = new Set(byPath.keys());
  const additionalPublicRights = publicMedia.filter(path => !registeredPublicPaths.has(path)).sort();
  const excludedMedia = sourceMedia.filter(path => !publicPath(path, { release: true }));
  const excludedByExtension = {};
  for (const path of excludedMedia) {
    const extension = extname(path).toLowerCase();
    excludedByExtension[extension] = (excludedByExtension[extension] || 0) + 1;
  }
  const vendorCandidates = [...releaseFiles.keys()]
    .filter(path => path.startsWith('/vendor/') || path.startsWith('/packages/')).sort();
  if (!plain(register.counts) || register.counts.models !== registeredModels.length
    || register.counts.webpRenders !== registeredRenders.length || register.counts.total !== byPath.size
    || register.counts.approved !== status.claimedApproved
    || register.counts.unverified !== status.unverified)
    fail('RIGHTS_DECLARED_COUNT_MISMATCH');

  return {
    format: 'velance-p7-rights-audit/1',
    localAudit: 'PASS_LOCAL',
    publicLaunch: 'NO_GO',
    g0LegalGate: 'BLOCKED',
    legalDistributionAuthorizedByAudit: false,
    disclaimer: 'SHA-256 proves byte identity only; APPROVED metadata cannot prove independent legal authorization.',
    sourceRelease: {
      id: release.id, manifestFormat: release.manifest.format, files: releaseFiles.size,
      sourceBytesMatchRelease: true, manifestIdVerified: true,
      historicalP4ReleaseId: historicalP4ReleaseId || null,
      matchesHistoricalP4Release: historicalP4ReleaseId ? release.id === historicalP4ReleaseId : null
    },
    registeredRights: { models: registeredModels.length, webpRenders: registeredRenders.length,
      total: byPath.size, ...status, legalSignaturesIndependentlyVerified: 0,
      provenanceMissingFields: Object.fromEntries(Object.entries(evidenceGaps).sort(([a], [b]) => a.localeCompare(b))) },
    publicRightsScope: { mediaFiles: publicMedia.length, coveredByP5Register: byPath.size,
      additionalRightsNeeded: additionalPublicRights,
      complete: additionalPublicRights.length === 0 && status.unverified === 0 && status.rejected === 0
        && status.claimedApproved === byPath.size ? 'AWAITING_INDEPENDENT_LEGAL_SIGNOFF' : false },
    excludedSourceMedia: { count: excludedMedia.length, byExtension: excludedByExtension,
      examples: excludedMedia.sort().slice(0, 16),
      note: 'Not in immutable public release; no distribution authority inferred if publishing later.' },
    otherLegalReview: {
      thirdPartyCodeCandidates: vendorCandidates,
      brandTrademarkRights: 'UNVERIFIED',
      environmentOrRenderSceneLineage: 'UNVERIFIED',
      note: 'Vehicle brand marks, texture/HDRI, original render inputs, fonts and third-party runtime licenses require separate human review.'
    }
  };
}

export async function auditLocal(root = ROOT) {
  const storeDir = mkdtempSync(join(tmpdir(), 'velance-p7-rights-'));
  try {
    const snapshot = await createSnapshot({ sourceRoot: root, storeDir });
    const release = await verifySnapshot({ storeDir, id: snapshot.id });
    const register = JSON.parse(readFileSync(join(root, 'docs/p5-asset-rights-register.json'), 'utf8'));
    const modelManifest = JSON.parse(readFileSync(join(root, 'assets/models/manifest.json'), 'utf8'));
    let historicalP4ReleaseId = null;
    const prior = join(root, 'tools/perf/results/p4-real-asset-virtual-10-25-50-100.json');
    if (existsSync(prior)) {
      const p4 = JSON.parse(readFileSync(prior, 'utf8'));
      historicalP4ReleaseId = p4.assets?.releasedId || null;
    }
    return auditRights({ root, release, register, modelManifest, historicalP4ReleaseId });
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out'
      || !/^tools\/perf\/results\/p7-rights-audit-[a-zA-Z0-9_-]+\.json$/.test(args[1]))) {
      fail('USAGE', 'node tools/p7/rights.mjs [--out tools/perf/results/p7-rights-audit-<label>.json]');
    }
    const out = args.length ? resolve(ROOT, args[1]) : null;
    if (out && existsSync(out)) fail('EVIDENCE_ALREADY_EXISTS', out);
    assert(Number(process.versions.node.split('.')[0]) >= 24, 'Requires Node 24+');
    const report = await auditLocal();
    report.generatedAtUtc = new Date().toISOString();
    if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ audit: 'FAIL_CLOSED', code: error.code || 'AUDIT_ERROR', detail: error.message }));
    process.exitCode = 1;
  }
}
