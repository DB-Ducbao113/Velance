import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const json = path => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const register = json('docs/p5-asset-rights-register.json');
const ledger = json('docs/p9-asset-source-ledger.json');
const models = json('docs/p9-model-candidates.json');
const images = json('docs/p9-image-lineage.json');

test('96 P5 assets retain NO_GO while all model and render records now cite source metadata', () => {
  assert.equal(register.publicUseAllowed, false);
  assert.deepEqual(register.counts, { models: 16, webpRenders: 80, total: 96, unverified: 96, approved: 0 });
  const byPath = new Map(register.entries.map(x => [x.path, x]));
  assert.equal(byPath.size, 96);
  for (const source of ledger.models) {
    const entry = byPath.get(source.publicPath);
    assert(entry);
    assert.equal(entry.originalSourceUrl, source.exporter.url);
    assert.equal(entry.discoveredAttribution?.uploaderProfile, source.exporter.uploaderProfile);
    assert.equal(entry.discoveredAttribution?.uploaderClaimLicense, source.exporter.exporterLicenseClaim);
    assert.equal(entry.independentProvenanceChecked, null);
    assert.equal(entry.approvalStatus, 'UNVERIFIED');
  }
  for (const render of ledger.renders) {
    const entry = byPath.get(render.path);
    assert(entry);
    assert.equal(entry.discoveredRenderLineage?.basedOnPublicModelPath, render.modelPath);
    assert.equal(entry.discoveredRenderLineage?.modelRightsNotYetApproved, true);
    assert.equal(entry.approvalStatus, 'UNVERIFIED');
  }
  assert.equal(ledger.models.length, 16);
  assert.equal(ledger.renders.length, 80);
  assert.equal(ledger.environments.length, 2);
  assert(ledger.environments.every(x => x.knownExternalSource === null && x.rightsStatus === 'UNVERIFIED'));
});

test('forensics distinguishes exact original source URLs from legal permission and page-license conflicts', () => {
  assert.equal(models.models.length, 16);
  const origins = new Map(models.models.map(x => [x.file, x]));
  for (const item of ledger.models) {
    const file = item.publicPath.split('/').at(-1);
    const record = origins.get(file);
    assert(record, file);
    assert.equal(record.embeddedSketchfabExporterEvidence.sourceModelUrl, item.exporter.url);
    assert.equal(record.original.sha256, item.originalSha256);
    assert.equal(record.public.sha256, item.publicSha256);
    assert.equal(record.clearanceStatus, 'UNVERIFIED');
  }
  const laferrari = origins.get('2014_ferrari_laferrari.glb');
  assert.equal(laferrari.embeddedSketchfabExporterEvidence.licenseLabelAtExport, 'CC-BY-NC-SA-4.0');
  assert.equal(laferrari.independentWebResearch.currentIndexedLicense, 'CC-BY-4.0');
  const corvette = origins.get('corvette_stingray.glb');
  assert.equal(corvette.independentWebResearch.exactUrlCorroborated, false);
});

test('80 image records show 45 verified reencodes and 35 unproven legacy WebPs', () => {
  assert.equal(images.carRenders.length, 80);
  assert.equal(images.garage.length, 2);
  assert.equal(images.investigation.exactSharpWebpFromCurrentPng, 45);
  assert.equal(images.investigation.olderLosslessNotReproduced, 35);
  const linked = new Set(ledger.renders.map(x => x.path));
  assert.equal(new Set(images.carRenders.map(x => x.path)).size, 80);
  for (const image of images.carRenders) {
    assert(linked.has(image.path), image.path);
    assert.equal(image.legalRights, 'UNVERIFIED');
    assert.equal(image.sourceRightsUrl, null);
  }
  assert(images.garage.every(x => x.sourceRightsUrl === null && x.legalRights === 'UNVERIFIED'));
});

test('P9 CLI --audit re-hashes current sources and fails on inconsistent evidence', () => {
  const result = spawnSync(process.execPath, ['tools/p9/source-ledger.mjs', '--audit'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.result, 'PASS_LOCAL_PROVENANCE_METADATA');
  assert.equal(report.publicRightsApproved, 0);
  assert.equal(report.publicLaunch, 'NO_GO');
  assert.equal(report.models, 16);
  assert.equal(report.renders, 80);
  assert.equal(report.environments, 2);
  assert.deepEqual(report.missingLivePage, ['/assets/models/corvette_stingray.glb']);
  assert.deepEqual(report.livePageConflicts, ['/assets/models/2014_ferrari_laferrari.glb']);
});
