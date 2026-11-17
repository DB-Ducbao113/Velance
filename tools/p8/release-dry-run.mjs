#!/usr/bin/env node
// Explicitly local, manual candidate release verification. This script DOES NOT
// publish/upload files, call providers, use credentials or approve asset rights.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshot, verifySnapshot, activateRelease, readActiveRelease } from '../delivery/release.mjs';
import { validateStagingFile } from '../p6/staging.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.argv.length, 2, 'No deployment args supported');
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node24+ required');
const policy = validateStagingFile(new URL('../../config/p6/private-staging.json', import.meta.url));
assert.equal(policy.deployEnabled, false);
assert.equal(policy.publicLaunchAuthorized, false);
assert.equal(policy.edge.telemetry.enabled, false);

const realDb = join(ROOT, 'tools/ops/telemetry.db');
const fingerprint = () => existsSync(realDb) ? (() => {
  const stat = statSync(realDb);
  return { bytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
})() : null;
const initialDb = fingerprint();
const storeDir = mkdtempSync(join(tmpdir(), 'velance-p8-ci-dry-run-'));
try {
  const snapshot = await createSnapshot({ sourceRoot: ROOT, storeDir });
  const checked = await verifySnapshot({ storeDir, id: snapshot.id });
  const pointer = await activateRelease({ storeDir, id: snapshot.id });
  assert.equal(checked.id, snapshot.id);
  assert.equal(pointer.active, snapshot.id);
  assert.equal(readActiveRelease({ storeDir }).active, snapshot.id);
  const paths = checked.manifest.files.map(entry => entry.path);
  const models = paths.filter(x => /^\/assets\/models\/[^/]+\.glb$/.test(x)).length;
  const editorial = paths.filter(x => /^\/assets\/images\/[^/]+\/[^/]+\.webp$/.test(x)).length;
  const environment = paths.filter(x => /^\/assets\/environment\/[^/]+\.webp$/.test(x)).length;
  assert.equal(models, 16);
  assert.equal(editorial, 80);
  assert.equal(environment, 2);
  assert(!paths.some(x => /(?:^\/ops\/|^\/tools\/|^\/docs\/|^\/\.env|telemetry\.db|models_original|models_prepared|\.png$)/.test(x)));
  assert.deepEqual(fingerprint(), initialDb, 'Real database changed');
  const result = {
    format: 'velance-p8-ephemeral-release-dry-run/1',
    result: 'PASS_LOCAL_ONLY',
    releaseSha256: snapshot.id,
    totalPublicAllowlistedFiles: paths.length,
    glbFiles: models, editorialWebpFiles: editorial, environmentWebpFiles: environment,
    cloudDeploymentPerformed: false, publicLaunch: 'NO_GO', uploadedAssets: 0,
    approvedAssetRightsFromThisCheck: 0,
    realDatabaseUnchanged: true,
    note: 'Temporary private immutable release verified on this local runner. No distribution authorization.'
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  rmSync(storeDir, { recursive: true, force: true });
}
