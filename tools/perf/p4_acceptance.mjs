// Consolidates reproducible P4 local evidence; does not rerun or conceal failed
// workloads. Source reports are read-only and output is create-only.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = resolve(ROOT, 'tools/perf/results');
const expected = {
  backend: 'p4-backend-30day-10rps.json',
  overload: 'p4-backend-overload-100rps.json',
  delivery: 'p4-delivery-10rps.json',
  browser: 'p4-browser-both-loopback.json',
  native: 'p4-native.tap'
};
const args = process.argv.slice(2);
let out = resolve(BASE, 'p4-acceptance.json');
const source = { ...expected };
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i], value = args[i + 1];
  if (typeof value !== 'string' || value.startsWith('--')) throw new Error('P4 acceptance expects --out / --backend / --overload / --delivery / --browser / --native <path>');
  if (flag === '--out') out = resolve(value);
  else if (['--backend', '--overload', '--delivery', '--browser', '--native'].includes(flag))
    source[flag.slice(2)] = value;
  else throw new Error('Unknown P4 acceptance argument: ' + flag);
}
const path = item => resolve(BASE, source[item]);
const readJSON = name => JSON.parse(readFileSync(path(name), 'utf8'));
const number = n => Number.isFinite(n) ? +n.toFixed(3) : null;
function readTAP() {
  const raw = readFileSync(path('native'), 'utf8');
  const summary = {};
  for (const field of ['tests', 'pass', 'fail', 'skipped']) {
    const m = raw.match(new RegExp(`^# ${field} (\\d+)$`, 'm'));
    if (!m) throw new Error('Missing native TAP field: ' + field);
    summary[field] = Number(m[1]);
  }
  return summary;
}
const backend = readJSON('backend'), overload = readJSON('overload'),
  delivery = readJSON('delivery'), browser = readJSON('browser'), native = readTAP();
assert.equal(backend.profile?.days, 30, 'backend report is not a full 30-day dataset');
assert.equal(backend.profile?.seedSessions, 30_000);
assert.equal(backend.profile?.seedSamples, 9_000_000);
assert.equal(backend.profile?.offeredRatePerSecond, 10);
assert.equal(backend.mode, 'normal');
assert.equal(overload.mode, 'overload');
assert.equal(overload.profile?.offeredRatePerSecond, 100);
assert.equal(delivery.format, 'velance-p4-delivery-capacity/1');
assert.deepEqual(browser.settings?.backends, ['webgpu', 'webgl']);
assert.equal(browser.settings?.pairs, 3);
const checks = (set, prefix = '') => Object.fromEntries(Object.entries(set ?? {})
  .filter(([name]) => name !== 'mode' && name !== 'overall' && name !== 'optionalLargeWindowProbe')
  .map(([name, value]) => [prefix + name, value === true]));
const backendGates = {
  ...checks(backend.gates),
  largeWindow422: backend.dashboard?.expected422ProbedSeparately?.status === 422
    && backend.dashboard.expected422ProbedSeparately.valid === true,
  offeredExactly600: backend.ingest?.offered === 600,
  noLocalSenderDrop: backend.ingest?.localDropped === 0,
  allAckReceiptsDurable: backend.verification?.ok === true,
  completeJSON: backend.ingest?.invalidResponses === 0
};
const deliveryGates = {
  threeModes: delivery.modes?.length === 3,
  statusesAndPolicy: delivery.modes?.every(mode => {
    const status = mode.mode === 'warm' ? 304 : 200;
    return mode.load.offered === mode.load.sent && mode.load.sent === mode.load.completed
      && mode.load.transportErrors === 0 && mode.statusCounts[status] === mode.load.offered
      && Object.keys(mode.policyViolations || {}).length === 0;
  }) === true,
  simultaneousBinary: delivery.concurrencyProbe?.offered === 16
    && delivery.concurrencyProbe?.completed === 16
    && Object.keys(delivery.concurrencyProbe?.policyViolations || {}).length === 0,
  upstreamIsolation: delivery.upstreamOutage?.passed === true
};
const overloadGates = {
  intentional429: overload.ingest?.expected429 > 0,
  noSilentDrop: overload.ingest?.localDropped === 0,
  noTimeout: overload.ingest?.timeout === 0,
  integrity: overload.verification?.ok === true,
  successGateNotMisapplied: overload.gates?.overall === null
    && overload.gates?.validOfferedSuccess99_9pct === null
};
const browserGates = {
  bothBackends16Models: browser.gates?.all16AndBackend === true,
  noPageErrors: browser.gates?.browserErrors === true,
  allSixFrameTargets: browser.gates?.frameDelta === true && browser.verdicts?.length === 6,
  perBackendThreePaired: ['webgpu', 'webgl2'].every(backendName => {
    const entries = browser.cases?.filter(c => c.backend === backendName) ?? [];
    return entries.length === 6
      && [0, 1, 2].every(pair => entries.some(e => e.name === 'baseline' && e.pair === pair)
        && entries.some(e => e.name === 'candidate' && e.pair === pair));
  })
};
const nativeGates = { validNativeTap: native.tests >= 7 && native.tests === native.pass && native.fail === 0 };
const groups = { backend30Day: backendGates, overload: overloadGates,
  delivery: deliveryGates, browser: browserGates, native: nativeGates };
const statuses = Object.fromEntries(Object.entries(groups).map(([group, tests]) =>
  [group, Object.values(tests).every(v => v === true) ? 'PASS_LOCAL' : 'FAIL_LOCAL']));
const report = {
  format: 'velance-p4-capacity-acceptance/1', timestampUtc: new Date().toISOString(),
  environment: { node: process.version, os: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model },
  sourceFiles: Object.fromEntries(Object.keys(source).map(key => [key, path(key)])),
  statuses: { ...statuses, overallLocal: Object.values(statuses).every(s => s === 'PASS_LOCAL') ? 'PASS_LOCAL' : 'MIXED_OR_FAIL',
    cdnProduction: 'NOT_CONFIGURED', singleHostAvailabilitySLO: 'NOT_PROVEN', concurrent100RealUsers: 'NOT_PROVEN',
    realWorldGPUTestMatrix: 'NOT_COMPLETE', publicReleaseLicensing: 'BLOCKED' },
  checks: groups,
  metrics: {
    backend: { seedSessions: backend.profile.seedSessions, seedSamples: backend.profile.seedSamples,
      databaseBytes: backend.profile.seedBytes, seedMs: number(backend.profile.seedMs),
      offered: backend.ingest.offered, ack: backend.ingest.acknowledged200,
      successRate: backend.ingest.successRateOfValidOffered,
      ingestP95Ms: number(backend.latencyMs.arrivalToAck.p95),
      ingestP99Ms: number(backend.latencyMs.arrivalToAck.p99),
      dashboardP95Ms: number(backend.dashboard.p95Ms),
      peakRssBytes: backend.resources.peakRssBytes,
      maxEventLoopP99Ms: number(backend.resources.maxEventLoopP99Ms),
      dbIntegrity: backend.verification.integrity,
      persistedCounts: backend.verification.counts },
    overload: { offered: overload.ingest.offered, ack: overload.ingest.acknowledged200,
      expected429: overload.ingest.expected429, rate: overload.profile.offeredRatePerSecond },
    delivery: { offeredAcrossModes: delivery.modes.reduce((n, x) => n + x.load.offered, 0),
      completedAcrossModes: delivery.modes.reduce((n, x) => n + x.load.completed, 0),
      maxModeP95Ms: Math.max(...delivery.modes.map(x => x.latencyMs.completed.p95)),
      warmBodyBytes: delivery.modes.find(x => x.mode === 'warm')?.transfer.actualBodyBytes,
      syntheticReleaseBytes: delivery.fixture.releaseBytes,
      simultaneousBinary: delivery.concurrencyProbe },
    browser: { pairCountPerBackend: browser.settings.pairs,
      pairedMedianFrameDeltas: browser.verdicts.map(v => ({ backend: v.backend,
        stage: v.stage, pairedMedianDeltaMs: v.pairedMedianDeltaMs, passed: v.passed })) },
    native
  },
  scope: {
    localFixtureOnly: true, realTelemetryDbModified: false,
    productionAssetModified: false, deployed: false, committed: false, pushed: false,
    note: 'One finite 60s normal benchmark and 10s overload do not prove production SLOs or global CDN capacity.'
  }
};
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output: out, status: report.statuses, checks: report.checks,
  backend: report.metrics.backend, overload: report.metrics.overload }, null, 2));
