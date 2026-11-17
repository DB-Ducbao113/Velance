#!/usr/bin/env node
// Reconstruct exporter-reported Sketchfab sources and local WebP lineage.
// Neither uploader metadata nor a CC label proves third-party copyright
// ownership or the rights to publicly distribute a downloadable 3D asset.
// This tool NEVER approves an asset, deploys, accesses networks or touches DBs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VEHICLES } from '../../src/data/vehicles.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTER = join(ROOT, 'docs/p5-asset-rights-register.json');
const LEDGER = join(ROOT, 'docs/p9-asset-source-ledger.json');
const ORIGINAL = join(ROOT, 'assets/models_original');
const PUBLIC = join(ROOT, 'assets/models');

// Current first-party page search observations made on 2026-11-17. These are
// uploader claims, not ownership checks; null = no corroborating live listing.
const LIVE = Object.freeze({
  '2014_ferrari_laferrari.glb': { license: 'CC-BY-4.0', concerns: ['license_changed_or_conflicting_exporter', 'Need For Speed Mobile model', 'Ddiaz profile says noncommercial references'] },
  '2023_ferrari_sf90_xx_stradale.glb': { license: 'CC-BY-4.0', concerns: ['CSR2 game-derived model', 'Ddiaz profile says noncommercial references'] },
  '2024_lamborghini_revuelto.glb': { license: 'CC-BY-4.0', concerns: [] },
  '2025_koenigsegg_jesko_attack_7376.glb': { license: 'CC-BY-4.0', concerns: [] },
  'aston_martin_valkyrie.glb': { license: 'CC-BY-4.0', concerns: ['rework of Cascade Models original; upstream rights not established'] },
  'bugatti_tourbillon_2024.glb': { license: 'CC-BY-4.0', concerns: [] },
  'corvette_stingray.glb': { license: null, concerns: ['Sketchfab page not independently retrieved in web search; original metadata only'] },
  'lamborghini_aventador.glb': { license: 'CC-BY-4.0', concerns: [] },
  'mclaren-765lt___with_windows__v2.glb': { license: 'CC-BY-4.0', concerns: [] },
  'mclaren_p1.glb': { license: 'CC-BY-4.0', concerns: ['NoAI uploader tag; preserve model-specific conditions'] },
  'mclaren_senna_free.glb': { license: 'CC-BY-4.0', concerns: [] },
  'mercedes-amg_project-one.glb': { license: 'CC-BY-4.0', concerns: [] },
  'pagani_huayra_free.glb': { license: 'CC-BY-4.0', concerns: [] },
  'pagani_utopia_2023.glb': { license: 'CC-BY-4.0', concerns: ['upstream author/embedded materials provenance unresolved'] },
  'porsche_911_with_interior.glb': { license: 'CC-BY-4.0', concerns: [] },
  'porsche_918_spyder_2015.glb': { license: 'CC-BY-4.0', concerns: [] }
});

function readExporterMetadata(file) {
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(20);
    assert.equal(readSync(fd, header, 0, header.length, 0), 20, 'GLB header too short: ' + file);
    assert.equal(header.toString('ascii', 0, 4), 'glTF', 'not a GLB');
    assert.equal(header.readUInt32LE(4), 2, 'expected GLB2');
    assert.equal(header.readUInt32LE(8), lstatSync(file).size, 'GLB declared size mismatch');
    assert.equal(header.readUInt32LE(16), 0x4e4f534a, 'first chunk must be JSON');
    const length = header.readUInt32LE(12);
    assert(length > 0 && length < 16 * 1024 * 1024, 'GLB JSON too large');
    const bytes = Buffer.alloc(length);
    assert.equal(readSync(fd, bytes, 0, length, 20), length, 'truncated GLB JSON');
    const document = JSON.parse(bytes.toString('utf8'));
    const extras = document?.asset?.extras;
    assert(extras && typeof extras === 'object' && document.asset.generator.startsWith('Sketchfab-'), 'missing Sketchfab exporter attribution');
    assert(typeof extras.source === 'string' && /^https:\/\/sketchfab\.com\/3d-models\/[a-z0-9-]+$/i.test(extras.source), 'untrusted Sketchfab source metadata');
    const author = /^(.+) \((https:\/\/sketchfab\.com\/[a-zA-Z0-9_.-]+)\)$/.exec(extras.author || '');
    assert(author, 'invalid author uploader reference');
    const license = /^(CC-BY(?:-NC-SA)?-4\.0) \((https?:\/\/creativecommons\.org\/licenses\/[^)]+)\)$/.exec(extras.license || '');
    assert(license, 'unrecognized original license claim');
    return { title: extras.title, url: extras.source, uploader: author[1], uploaderProfile: author[2],
      exporterLicenseClaim: license[1], claimedLicenseUrl: license[2].replace(/^http:/, 'https:'),
      generator: document.asset.generator };
  } finally { closeSync(fd); }
}

async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const routeOf = f => '/assets/models/' + f;
const normalize = url => url.replace(/^http:/, 'https:');
async function buildLedger(register) {
  const models = register.entries.filter(x => x.kind === 'prepared_3d_model');
  const renders = register.entries.filter(x => x.kind === 'derived_editorial_render');
  assert.equal(models.length, 16);
  assert.equal(renders.length, 80);
  assert.equal(VEHICLES.length, 16);
  const vehicleMap = new Map(VEHICLES.map(v => [v.id, v]));
  assert.equal(vehicleMap.size, 16);
  const modelMap = new Map(models.map(x => [x.path, x]));
  const modelSources = [];
  for (const entry of models) {
    const file = entry.path.split('/').at(-1);
    assert(LIVE[file], 'missing live-status inventory ' + file);
    const originalPath = join(ORIGINAL, file), optimizedPath = join(PUBLIC, file);
    assert(existsSync(originalPath) && existsSync(optimizedPath), 'missing original or public model: ' + file);
    const meta = readExporterMetadata(originalPath);
    assert.equal(normalize(meta.claimedLicenseUrl), normalize(
      meta.exporterLicenseClaim === 'CC-BY-4.0'
        ? 'https://creativecommons.org/licenses/by/4.0/'
        : 'https://creativecommons.org/licenses/by-nc-sa/4.0/'));
    assert.equal(entry.sha256, await checksum(optimizedPath), 'optimized model register SHA mismatch ' + file);
    const match = LIVE[file].license === null ? 'NO_INDEPENDENT_LIVE_LISTING' :
      LIVE[file].license === meta.exporterLicenseClaim ? 'EXPORTER_AND_LIVE_PAGE_LICENSE_LABEL_AGREE'
        : 'CONFLICT_EXPORTER_VS_LIVE_PAGE';
    const source = { publicPath: entry.path,
      originalFile: 'assets/models_original/' + file, originalSha256: await checksum(originalPath),
      publicSha256: entry.sha256, exporter: meta,
      livePage: { checkedOn: '2026-11-17', listedLicenseClaim: LIVE[file].license,
        listingUrl: meta.url, comparison: match, concerns: LIVE[file].concerns },
      publicRights: 'UNVERIFIED', ownershipChecked: false, commercialPermissionChecked: false,
      selfHostedWebglPermissionChecked: false };
    modelSources.push(source);
  }
  const carToModel = new Map([...vehicleMap].map(([id, vehicle]) => [id, routeOf(vehicle.file)]));
  assert.equal(new Set(carToModel.values()).size, 16);
  for (const path of carToModel.values()) assert(modelMap.has(path), 'VEHICLES model not in register: ' + path);
  const rendersOut = renders.map(entry => {
    const asset = carToModel.get(entry.carAlbum);
    assert(asset, 'image album not mapped to VEHICLES ' + entry.carAlbum);
    return {
      path: entry.path, sha256: entry.sha256,
      modelPath: asset,
      localGeneration: { pipeline: 'tools/render/shoot.mjs + tools/render/render.html',
        renderer: 'Three.js WebGPU + GLTFLoader + RoomEnvironment + Sharp PNG -> WebP',
        outputPattern: '5 camera angles per VEHICLES id',
        provenanceLevel: 'REPRODUCIBLE_CODE_PRESENT__OUTPUT_NOT_BYTE_VERIFIED' },
      publicRights: 'UNVERIFIED', underlyingModelCopyrightClearance: false
    };
  });
  const missingPublic = [
    '/assets/environment/private_garage_1080x1350.webp',
    '/assets/environment/private_garage_1920x1080.webp'
  ];
  const environments = [];
  for (const path of missingPublic) {
    const file = join(ROOT, path.slice(1));
    assert(existsSync(file), 'missing environment media ' + path);
    environments.push({ path, sha256: await checksum(file), knownExternalSource: null,
      authorOrOwner: null, license: null, rightsStatus: 'UNVERIFIED',
      note: 'Two environmental WebPs are not in the 96-entry P5 register. Creator and source not proven.' });
  }
  return { format: 'velance-p9-asset-source-ledger/1', generatedAtUtc: new Date().toISOString(),
    rightsApproval: 'NO_GO', sourceKind: 'SKETCHFAB_EXPORTER_ASSET_EXTRAS',
    caveat: 'Source metadata identifies a download listing and uploader, not true owner or authorized distributor. Live page license statements can conflict; self-hosting still requires review.',
    originalModelCount: modelSources.length, renderCount: rendersOut.length,
    environmentCount: environments.length, models: modelSources, renders: rendersOut, environments };
}

function updateRegister(register, ledger) {
  assert.equal(register.format, 'velance-p5-asset-rights-register/1');
  assert.equal(register.publicUseAllowed, false);
  assert.equal(register.counts.approved, 0);
  assert.equal(register.counts.unverified, 96);
  assert.equal(register.entries.length, 96);
  const byModel = new Map(ledger.models.map(x => [x.publicPath, x]));
  const byRender = new Map(ledger.renders.map(x => [x.path, x]));
  for (const entry of register.entries) {
    assert.equal(entry.approvalStatus, 'UNVERIFIED', 'Refuse to override approved rights record');
    assert(entry.originalSourceUrl === null || typeof entry.originalSourceUrl === 'string');
    assert(entry.originalSourceProof === null || typeof entry.originalSourceProof === 'string');
    if (entry.kind === 'prepared_3d_model') {
      const model = byModel.get(entry.path); assert(model, 'missing provenance for ' + entry.path);
      assert(entry.originalSourceUrl === null || entry.originalSourceUrl === model.exporter.url,
        'source conflict in existing register: ' + entry.path);
      entry.originalSourceUrl = model.exporter.url;
      entry.originalSourceProof = `Exact embedded Sketchfab exporter asset.extras.source in ${model.originalFile}; source original SHA256=${model.originalSha256}. See docs/p9-asset-source-ledger.json; NOT independent author/rightsholder proof.`;
      entry.discoveredAttribution = {
        uploaderDisplayName: model.exporter.uploader,
        uploaderProfile: model.exporter.uploaderProfile,
        uploaderClaimLicense: model.exporter.exporterLicenseClaim,
        uploaderClaimLicenseUrl: model.exporter.claimedLicenseUrl,
        currentListingClaim: model.livePage.listedLicenseClaim,
        licenseClaimComparison: model.livePage.comparison,
        concerns: model.livePage.concerns,
        verificationLevel: 'SOURCE_URL_FROM_EMBEDDED_EXPORT_METADATA__LEGAL_RIGHTS_UNVERIFIED'
      };
    } else {
      const image = byRender.get(entry.path); assert(image, 'missing render for ' + entry.path);
      entry.discoveredRenderLineage = {
        basedOnPublicModelPath: image.modelPath,
        evidenceScript: image.localGeneration.pipeline,
        evidenceLevel: image.localGeneration.provenanceLevel,
        modelRightsNotYetApproved: true
      };
    }
    // Existing legal decision fields MUST remain null/unverified until an
    // independent reviewer checks actual ownership, licenses and terms.
    assert.equal(entry.licenseName, null);
    assert.equal(entry.exactLicenseUrl, null);
    assert.equal(entry.independentProvenanceChecked, null);
    assert.equal(entry.permitsSelfHostedWebGLDistribution, null);
    assert.equal(entry.permitsCommercialWebsite, null);
    assert.equal(entry.reviewer, null);
    assert.equal(entry.reviewedAtUtc, null);
  }
  return register;
}

function verifyRecordedProvenance(register, ledger) {
  assert(existsSync(LEDGER), 'P9 source evidence ledger missing');
  const recorded = JSON.parse(readFileSync(LEDGER, 'utf8'));
  assert.equal(recorded.format, ledger.format);
  assert.equal(recorded.rightsApproval, 'NO_GO');
  assert.equal(recorded.sourceKind, ledger.sourceKind);
  assert.equal(recorded.models.length, 16);
  assert.equal(recorded.renders.length, 80);
  assert.equal(recorded.environments.length, 2);
  // The recorded timestamp is historical; all asset/source/rights bytes
  // and metadata must remain identical after that snapshot.
  for (const section of ['models', 'renders', 'environments']) {
    assert.deepEqual(recorded[section], ledger[section], 'P9 evidence differs from current inputs: ' + section);
  }
  const models = new Map(ledger.models.map(x => [x.publicPath, x]));
  const renders = new Map(ledger.renders.map(x => [x.path, x]));
  for (const item of register.entries) {
    assert.equal(item.approvalStatus, 'UNVERIFIED', 'Do not infer automatic legal approval');
    if (item.kind === 'prepared_3d_model') {
      const model = models.get(item.path);
      assert(model, 'model not in ledger: ' + item.path);
      assert.equal(item.originalSourceUrl, model.exporter.url,
        'P5 registered source URL no longer matches embedded GLB: ' + item.path);
      assert(item.originalSourceProof?.includes(model.originalSha256), 'Missing original file SHA provenance: ' + item.path);
      assert.equal(item.discoveredAttribution?.uploaderProfile, model.exporter.uploaderProfile);
      assert.equal(item.discoveredAttribution?.uploaderClaimLicense, model.exporter.exporterLicenseClaim);
      assert.equal(item.discoveredAttribution?.licenseClaimComparison, model.livePage.comparison);
      assert.equal(item.discoveredAttribution?.verificationLevel, 'SOURCE_URL_FROM_EMBEDDED_EXPORT_METADATA__LEGAL_RIGHTS_UNVERIFIED');
    } else {
      const render = renders.get(item.path);
      assert(render, 'render not in ledger: ' + item.path);
      assert.equal(item.discoveredRenderLineage?.basedOnPublicModelPath, render.modelPath);
      assert.equal(item.discoveredRenderLineage?.modelRightsNotYetApproved, true);
      assert.equal(item.discoveredRenderLineage?.evidenceLevel, render.localGeneration.provenanceLevel);
    }
    for (const field of ['licenseName', 'exactLicenseUrl', 'independentProvenanceChecked',
      'permitsSelfHostedWebGLDistribution', 'permitsCommercialWebsite', 'reviewer', 'reviewedAtUtc'])
      assert.equal(item[field], null, 'Prevent automatic rights signoff ' + item.path + ': ' + field);
  }
}

if (import.meta.main) {
  let pending = null;
  try {
    assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24 required');
    assert(process.argv.length === 3 && ['--audit', '--record'].includes(process.argv[2]),
      'Usage: node tools/p9/source-ledger.mjs --audit|--record');
    const register = JSON.parse(readFileSync(REGISTER, 'utf8'));
    const ledger = await buildLedger(register);
    if (process.argv[2] === '--record') {
      assert(!existsSync(LEDGER), 'Refuse to overwrite provenance ledger; review differences first');
      writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      const updated = updateRegister(register, ledger);
      pending = join(ROOT, 'docs/.p9-rights-register-pending-' + process.pid + '.json');
      writeFileSync(pending, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(pending, REGISTER);
      pending = null;
    } else {
      verifyRecordedProvenance(register, ledger);
    }
    console.log(JSON.stringify({ result: 'PASS_LOCAL_PROVENANCE_METADATA',
      mode: process.argv[2], models: ledger.models.length, renders: ledger.renders.length,
      environments: ledger.environments.length,
      livePageConflicts: ledger.models.filter(m => m.livePage.comparison === 'CONFLICT_EXPORTER_VS_LIVE_PAGE').map(m => m.publicPath),
      missingLivePage: ledger.models.filter(m => m.livePage.comparison === 'NO_INDEPENDENT_LIVE_LISTING').map(m => m.publicPath),
      publicRightsApproved: 0, publicLaunch: 'NO_GO' }, null, 2));
  } catch (error) {
    console.error('[P9] FAIL_CLOSED ' + error.message);
    process.exitCode = 1;
  } finally {
    if (pending && existsSync(pending)) unlinkSync(pending);
  }
}
