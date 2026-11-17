import test from 'node:test';
import assert from 'node:assert/strict';
import { FREE_STAGING_POLICY, parseOptions, smokeFreeStaging } from '../free-staging.mjs';

test('zero-cost plan cannot enable internet, cloud or telemetry upstream', () => {
  assert.equal(FREE_STAGING_POLICY.costVnd, 0);
  assert.equal(FREE_STAGING_POLICY.networkBinding, '127.0.0.1');
  assert.equal(FREE_STAGING_POLICY.upstream, null);
  assert.equal(FREE_STAGING_POLICY.cloud, false);
  assert.equal(FREE_STAGING_POLICY.publicLaunchAuthorized, false);
  assert.equal(FREE_STAGING_POLICY.licensedAssetsForPublicUse, false);
});

test('CLI accepts only loopback smoke or explicit local review with bounded port', () => {
  assert.deepEqual(parseOptions(), { mode: 'smoke', port: 0 });
  assert.deepEqual(parseOptions(['--mode', 'review', '--port', '8081']), { mode: 'review', port: 8081 });
  for (const args of [
    ['--mode', 'deploy'], ['--mode', 'production'], ['--host', '0.0.0.0'],
    ['--port', '65536'], ['--port', '-1'], ['--port', '1.2'], ['--mode', 'smoke', '--port', '8090'],
    ['--upstream', 'http://127.0.0.1:8090'], ['--mode', 'review', '--mode', 'review']
  ]) assert.throws(() => parseOptions(args), undefined, args.join(' '));
});

test('real socket + immutable synthetic release smoke, default denied routes', async () => {
  const result = await smokeFreeStaging();
  assert.equal(result.status, 'PASS_LOCAL');
  assert.equal(result.binding, '127.0.0.1');
  assert.equal(result.releaseFiles, 5);
  assert.equal(result.securityChecks.privateRoutesDenied, 10);
  assert.equal(result.telemetryBackendEnabled, false);
  assert.equal(result.cloudResourcesCreated, 0);
});
