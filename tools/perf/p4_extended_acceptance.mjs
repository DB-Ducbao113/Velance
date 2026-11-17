// P4 strict local acceptance. Requires every fresh full-real report, never
// substitutes the earlier synthetic P4 gate for missing real-user evidence.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE = join(ROOT, 'tools/perf/results');
const sources = {
  original: 'p4-acceptance.json',
  constrained: 'p4-browser-both-constrained.json',
  webgpu4: 'p4-multitab-webgpu-4.json',
  webgl4: 'p4-multitab-webgl2-4.json',
  virtual: 'p4-real-asset-virtual-10-25-50-100.json',
  mixed: 'p4-mixed-soak-60s-3day.json',
  native: 'p4-native-extended.tap'
};
const get = name => JSON.parse(readFileSync(join(EVIDENCE, sources[name]), 'utf8'));
const orig = get('original'), constrained = get('constrained'),
  webgpu = get('webgpu4'), webgl = get('webgl4'), virtual = get('virtual'), mixed = get('mixed');
const nativeText = readFileSync(join(EVIDENCE, sources.native), 'utf8');
const nativeStats = {};
for (const metric of ['tests', 'pass', 'fail', 'skipped']) {
  const match = nativeText.match(new RegExp('^# ' + metric + ' (\\d+)$', 'm'));
  if (!match) throw new Error('Native TAP does not declare ' + metric);
  nativeStats[metric] = Number(match[1]);
}
const check = (condition, description) => ({ passed: condition === true, description });
const originalChecks = {
  p4OriginalGate: check(orig.statuses?.overallLocal === 'PASS_LOCAL', 'P4 30-day SQLite, API, overload and synthetic delivery gate'),
  originalNoProductionClaim: check(orig.statuses?.cdnProduction === 'NOT_CONFIGURED', 'No invented CDN claim')
};
const constrainedChecks = {
  bothBackends: check(constrained.settings?.backends?.join(',') === 'webgpu,webgl' && constrained.settings?.pairs === 3,
    'Chrome constrained network 20Mbps/40ms; 3 pairs per backend'),
  allTwelveLoaded: check(constrained.cases?.length === 12
    && constrained.cases.every(c => c.state?.loaded === 16 && c.errors.length === 0 && !c.state.fallback),
    'Every A/B case loaded all 16 GLBs and had no errors'),
  allSixFrameDelta: check(constrained.verdicts?.length === 6
    && constrained.verdicts.every(v => v.passed && v.pairedMedianDeltaMs < 1),
    'Frame-gap candidate-baseline paired median below +1ms in 3 UI stages x2 backends')
};
const browserChecks = {};
for (const [key, report, expected] of [['webgpu4', webgpu, 'webgpu'], ['webgl4', webgl, 'webgl2']]) {
  browserChecks[key] = check(report.profile?.tabs === 4 && report.profile?.backend === expected
    && report.visitors?.length === 4 && report.gates?.noErrors && report.gates?.allLoaded16
    && report.gates?.allVisitorsCompleted && report.gates?.requestedBackend
    && report.gates?.telemetryOptedOut && report.overall === 'PASS_LOCAL'
    && report.visitors.every(v => v.loadMs <= 30000 && v.transferBytes > 40e6),
    'Four cold-cache same-GPU Chrome tabs loaded all 16 GLBs and completed overview/selected UI, <=30 seconds/tab');
}
const virtualProfiles = virtual.profiles || [];
const expectedCounts = [10, 25, 50, 100];
const virtualChecks = {
  realAssets: check(virtual.assets?.models === 16 && virtual.assets?.carWebpImages === 80
    && virtual.assets?.totalModelBytesPerUser > 40e6,
    'Real 16 GLBs and 80 editorial WebP in release, no synthetic small-file substitution'),
  fourProfiles: check(virtualProfiles.length === 4 && virtualProfiles.every((p, i) =>
    p.virtualHttpClients === expectedCounts[i] && p.passed && p.elapsedMs <= 120000
    && p.requests.completed === expectedCounts[i] * 22
    && p.requests.completed200 === expectedCounts[i] * 21
    && p.requests.completed304 === expectedCounts[i]
    && p.requests.failedVerification === 0 && p.requests.incomplete200 === 0
    && p.requests.status429 === 0 && p.requests.status503 === 0
    && p.requests.verifiedFiles === expectedCounts[i] * 21
    && p.observedPeakInFlight <= 16),
    '10/25/50/100 virtual journeys: 16 real GLB+5 real WebP+304, exact SHA/ETag/bytes'),
  correctConcurrentBoundary: check(virtual.config?.globalInflightLimit === 16
    && virtual.caveats.some(text => text.includes('do NOT represent 100 real browsers')),
    '100 virtual HTTP clients explicitly not asserted equivalent to 100 simultaneously active downloads')
};
const mixedChecks = {
  durationAndDB: check(mixed.profile?.durationSeconds === 60 && mixed.profile?.offeredRatePerSecond === 10
    && mixed.profile?.seededDays === 3 && mixed.profile?.seeds?.samples === 900000,
    '60s mixed read+write soak, 3-day 900k seeded samples'),
  offeredSustained: check(mixed.ingestion?.offered === 600 && mixed.ingestion?.acknowledged === 600
    && mixed.ingestion?.droppedBeforeSend === 0 && mixed.ingestion?.expected429 === 0
    && mixed.ingestion?.errors503 === 0 && mixed.ingestion?.timeout === 0
    && mixed.ingestion?.incomplete === 0 && mixed.ingestion?.network === 0,
    'Every one of 600 offered mixed POSTs acknowledged, no local drops/timeouts/HTTP errors'),
  readsAndBackup: check(mixed.reads?.offered === mixed.reads?.success && mixed.reads?.localDrops === 0
    && mixed.backup?.verified === true && mixed.backup.ackDuring > 0,
    'All mixed API reads full responses and native backup verified while writes continue'),
  crashRecovery: check(mixed.fault?.injected === true && mixed.fault?.passed === true
    && mixed.fault?.replay?.idempotent === true && mixed.fault?.orderedAdvance?.persisted === true,
    'Isolated SIGKILL/restart, ACKed receipts survive, identical replay and seq advance durable'),
  allSloGates: check(mixed.gates?.overall === true && mixed.verification?.ok === true,
    'Baseline p95/p99/read/RSS/loop, receipts, integrity, order and orphans passed')
};
const nativeChecks = {
  extendedNative: check(nativeStats.tests >= 16 && nativeStats.tests === nativeStats.pass
    && nativeStats.fail === 0, 'At least 16 native performance harness tests passed')
};
const groups = { priorP4: originalChecks, constrainedChrome: constrainedChecks,
  sameGpuMultitab: browserChecks, realAssetsVirtualUsers: virtualChecks,
  mixedSoakAndFault: mixedChecks, native: nativeChecks };
const groupsPassed = Object.values(groups).every(group => Object.values(group).every(value => value.passed));
const report = {
  format: 'velance-p4-extended-acceptance/1', createdAtUtc: new Date().toISOString(),
  result: groupsPassed ? 'PASS_LOCAL' : 'FAIL_LOCAL',
  evidenceFiles: sources, groups,
  measured: {
    conditioned: { cases: constrained.cases.length, pairedDeltaMs: constrained.verdicts.map(v =>
      ({ backend: v.backend, stage: v.stage, delta: v.pairedMedianDeltaMs })) },
    chrome: [webgpu, webgl].map(r => ({ backend: r.profile.backend, tabs: r.profile.tabs,
      loaded16: r.visitors.filter(v => v.state.loaded === 16).length, elapsedMs: r.elapsedMs,
      transferBytes: r.totalTransferBytes })),
    virtual: virtualProfiles.map(p => ({ users: p.virtualHttpClients, requests: p.requests.completed,
      receivedBytes: p.throughput.actualResponseBodyBytes, p95FullJourneyMs: p.latencyMs.fullJourney.p95,
      wallMs: p.elapsedMs, peakActualDownloads: p.observedPeakInFlight })),
    mixed: { offered: mixed.ingestion.offered, acknowledged: mixed.ingestion.acknowledged,
      readOffered: mixed.reads.offered, readSucceeded: mixed.reads.success,
      receiptCount: mixed.verification.durableReceipts,
      backupVerified: mixed.backup.verified, crashRecovery: mixed.fault.passed,
      rssPeakMiB: mixed.resources.rssBytes.max / 1048576,
      eventLoopP99MaxMs: mixed.resources.eventLoopP99Ms.max },
    native: nativeStats
  },
  deliberateUnverifiedProductionRequirements: [
    'Real 100 independent browser devices/users simultaneous over network',
    'Multi-region CDN PoPs/cache hit ratio/origin egress and TLS/WAF',
    '24h+ production-like soak, production host and WAN, iPhone hardware measurements',
    'Encrypted offsite backup/restore, persistent alert delivery, SSO and private origin',
    'GLB and render rights to public WebGL distribution'
  ],
  scope: 'Local fixture and real local assets only; nothing publicly deployed; no real telemetry.db touched'
};
const out = resolve(EVIDENCE, 'p4-extended-acceptance.json');
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ out, result: report.result,
  groups: Object.fromEntries(Object.entries(groups).map(([g, checks]) =>
    [g, Object.entries(checks).filter(([, result]) => !result.passed).map(([name]) => name)])) }, null, 2));
if (!groupsPassed) process.exitCode = 1;
