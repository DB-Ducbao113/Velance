// P6 provider-neutral private staging contract. This module does not provision
// infrastructure, distribute copyrighted assets, or open network listeners.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const RELEASE = '/r/<sha256>/...';
export const STAGING_CONTRACT = Object.freeze({
  format: 'velance-p6-private-staging/1',
  purpose: 'synthetic-or-cleared-assets-only',
  deployEnabled: false,
  publicLaunchAuthorized: false,
  origin: { publicRead: false, publicList: false, privateServiceIdentityRequired: true,
    directOriginBypassDenied: true, immutableReleasePath: RELEASE },
  edge: { httpsRequired: true, tlsCertificateProviderTestRequired: true, wafRequired: true,
    rateLimitRequired: true, originAuthRequired: true, cacheKey: 'canonical-path+representation',
    allow: ['GET /', 'HEAD /', 'GET /index.html', 'HEAD /index.html',
      'GET /r/<sha256>/<public-file>', 'HEAD /r/<sha256>/<public-file>'],
    telemetry: { enabled: false, explicitOptInRequired: true,
      onlyWhenApproved: 'POST /api/telemetry', requestCapBytes: 262144, cache: 'no-store' },
    denyByDefault: true, immutableCache: 'public, max-age=31536000, immutable',
    pointerCache: 'no-store' },
  privateServices: { opsDashboard: 'SSO+MFA+RBAC+private-network-only',
    readApis: 'private-only', metrics: 'private-only', health: 'private-only',
    database: 'single-writer-persistent-storage', bind: '127.0.0.1',
    offHostEncryptedBackupRequired: true },
  gates: { legalAssetReview: 'BLOCKED', providerTlsWafIamCdn: 'NEEDS_PROVIDER_TEST',
    opsIdentity: 'NEEDS_PROVIDER_TEST', privacyOwnerSignoff: 'BLOCKED',
    offHostRecovery: 'NEEDS_PROVIDER_TEST', externalAlertDelivery: 'NEEDS_PROVIDER_TEST',
    wanSoakAndDevices: 'NEEDS_PROVIDER_TEST', releaseCanaryRollback: 'NEEDS_PROVIDER_TEST' }
});

export function validateStagingContract(c) {
  assert.equal(c?.format, 'velance-p6-private-staging/1');
  assert.equal(c.deployEnabled, false, 'deploy must remain disabled');
  assert.equal(c.publicLaunchAuthorized, false, 'public launch must remain blocked');
  assert.equal(c.origin.publicRead, false);
  assert.equal(c.origin.publicList, false);
  assert.equal(c.origin.privateServiceIdentityRequired, true);
  assert.equal(c.origin.directOriginBypassDenied, true);
  assert.equal(c.origin.immutableReleasePath, RELEASE);
  assert.equal(c.edge.httpsRequired, true);
  assert.equal(c.edge.originAuthRequired, true);
  assert.equal(c.edge.wafRequired, true);
  assert.equal(c.edge.rateLimitRequired, true);
  assert.equal(c.edge.denyByDefault, true);
  assert.equal(c.edge.telemetry.enabled, false);
  assert.equal(c.edge.telemetry.explicitOptInRequired, true);
  assert.equal(c.edge.telemetry.onlyWhenApproved, 'POST /api/telemetry');
  assert.equal(c.edge.telemetry.requestCapBytes, 262144);
  assert.equal(c.edge.telemetry.cache, 'no-store');
  assert.equal(c.edge.pointerCache, 'no-store');
  assert.equal(c.edge.immutableCache, 'public, max-age=31536000, immutable');
  assert.deepEqual(c.edge.allow, STAGING_CONTRACT.edge.allow);
  assert.equal(c.privateServices.bind, '127.0.0.1');
  assert.equal(c.privateServices.offHostEncryptedBackupRequired, true);
  assert.deepEqual(c.gates, STAGING_CONTRACT.gates);
  return true;
}

export function validateStagingFile(file) {
  const contract = JSON.parse(readFileSync(file, 'utf8'));
  validateStagingContract(contract);
  return contract;
}
