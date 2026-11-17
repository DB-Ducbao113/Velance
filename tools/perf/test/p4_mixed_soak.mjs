import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { batchFor, parseOptions, percentile, stats } from '../p4_mixed_soak.mjs';

const source = resolve(import.meta.dirname, '../p4_mixed_soak.mjs');

// Native CI runs on a shared GitHub-hosted VM with variable CPU and fsync
// latency. Preserve strict performance/SLO exit codes in p4_mixed_soak.mjs,
// but only allow timing-only misses in this explicit 900k-row functional
// regression. Every durability, backup, recovery, 100%-ACK, RSS and
// concurrency gate MUST remain green. Do not report a performance PASS.
const SHARED_RUNNER_TIMING_ONLY = new Set([
  'ackP95Under150ms', 'ackP99Under300ms',
  'mixedReadsP95Under500ms', 'eventLoopP99Under50ms'
]);

function run(args, timeout = 18000, { allowSharedRunnerTiming = false } = {}) {
  const result = spawnSync(process.execPath, [source, ...args], {
    encoding: 'utf8', timeout, maxBuffer: 1024 * 1024
  });
  let gates = null, backup = null, ingestion = null, resources = null, reads = null, report = null;
  try {
    report = JSON.parse(result.stdout);
    gates = report.gates;
    backup = report.backup;
    ingestion = report.ingestion;
    resources = report.resources;
    reads = report.reads;
  } catch { /* A crash or timeout may leave no JSON report. */ }
  const failedGates = Object.entries(gates || {})
    .filter(([name, passed]) => name !== 'overall' && passed !== true)
    .map(([name]) => name);
  const timingOnlyOnSharedCI = process.env.CI === 'true' && allowSharedRunnerTiming
    && result.status === 1 && gates?.overall === false && failedGates.length > 0
    && failedGates.every(name => SHARED_RUNNER_TIMING_ONLY.has(name));
  if (timingOnlyOnSharedCI) {
    // Diagnostic is intentionally visible in the hosted test log.
    // The strict benchmark CLI still returns exit 1 for these measurements.
    console.log(`SHARED_RUNNER_SLO_NOT_PROVEN: ${failedGates.join(', ')}; ` +
      `ack p95=${ingestion?.latencyMs?.p95}ms p99=${ingestion?.latencyMs?.p99}ms; ` +
      'fixture correctness/durability verified separately');
  } else assert.equal(result.status, 0, `${args.join(' ')}:
stderr: ${result.stderr || result.error?.message || '(none)'}
signal: ${result.signal ?? '(none)'}
gates: ${JSON.stringify(gates)}
backup: ${JSON.stringify(backup)}
ingestion: ${JSON.stringify(ingestion && { offered: ingestion.offered, acknowledged: ingestion.acknowledged, latencyMs: ingestion.latencyMs })}
resources: ${JSON.stringify(resources)}
reads: ${JSON.stringify(reads)}`);
  return JSON.parse(result.stdout);
}

test('strict defaults, input hard caps and percentile computation', () => {
  assert.deepEqual(parseOptions([]), { duration: 60, rate: 10, days: 3, out: null, smoke: false });
  assert.deepEqual(parseOptions(['--smoke']), { duration: 3, rate: 10, days: 0, out: null, smoke: true });
  for (const args of [
    ['--duration', '0'], ['--duration', '121'], ['--duration', '2.5'], ['--rate', '11'],
    ['--rate', '0'], ['--days', '-1'], ['--days', '4'], ['--days', 'NaN'],
    ['--smoke', '--duration', '5'], ['--smoke', '--days', '0'], ['--duration', '2', '--duration', '3'],
    ['--out'], ['--db', '/tmp/not-a-fixture.db'], ['--unknown']
  ]) assert.throws(() => parseOptions(args), args.join(' '));
  assert.equal(percentile([3, 8, 2, 9], .95), 9);
  assert.deepEqual(stats([]), { n: 0, p50: null, p95: null, p99: null, max: null, mean: null });
  assert.equal(stats([3, 5, 7]).p95, 7);
});

test('stable session id, ordered seq and identical duplicate payloads', () => {
  const epoch = 1700000000000;
  const entries = Array.from({ length: 9 }, (_, i) => batchFor(i, epoch));
  assert.deepEqual(entries.slice(0, 4).map(x => x.seq), [0, 1, 1, 2]);
  assert.equal(entries[0].id, entries[3].id);
  assert.notEqual(entries[3].id, entries[4].id);
  assert.equal(entries[1].body, entries[2].body, 'duplicate delivery must be byte-identical');
  assert.equal(entries[1].key, entries[2].key);
  const event = JSON.parse(entries[0].body);
  assert.equal(event.samples.length, 3);
  assert(event.samples.every(sample => sample.t >= 0));
  assert(event.events.length >= 1);
  assert.equal(JSON.parse(entries[4].body).startedAt - event.startedAt, 400);
});

test('smoke: 10/s mixed loopback reads, backup, post-ACK SIGKILL/replay/restart are separately verified', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-mixed-evidence-'));
  try {
    const output = join(root, 'mixed.json');
    const response = run(['--smoke', '--out', output]);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(response.ingestion.offered, 30);
    assert.equal(report.ingestion.issued, 30);
    assert.equal(report.ingestion.acknowledged, 30);
    assert.equal(report.ingestion.expected429, 0);
    assert.equal(report.ingestion.timeout, 0);
    assert.equal(report.ingestion.network, 0);
    assert.equal(report.ingestion.duplicateAccepted, 7);
    assert.equal(report.ingestion.receiptsAcknowledged, 23);
    for (const category of ['summary', 'sessions', 'ready', 'metrics', 'detail']) {
      assert(report.reads.byRoute[category]?.count > 0, category);
      assert.deepEqual(report.reads.byRoute[category].statuses, { 200: report.reads.byRoute[category].count });
    }
    assert.equal(report.backup.verified, true);
    assert.equal(report.fault.injected, true);
    assert.equal(report.fault.signal, 'SIGKILL');
    assert.equal(report.fault.passed, true);
    assert.equal(report.fault.replay.idempotent, true);
    assert.equal(report.fault.orderedAdvance.persisted, true);
    assert.equal(report.verification.ok, true);
    assert.equal(report.verification.durableReceipts, 24, 'fault probe adds exactly one new seq');
    assert.deepEqual(report.verification.orphanCounts, { samples: 0, events: 0, batches: 0 });
    assert.equal(report.gates.overall, true);
    assert.equal('rawRequests' in report, false);
    assert(statSync(output).size < 30_000, 'keep aggregate-only output bounded');
    const duplicate = spawnSync(process.execPath, [source, '--smoke', '--out', output], { encoding: 'utf8', timeout: 2000 });
    assert.notEqual(duplicate.status, 0, 'must not replace report');
    assert(existsSync(output));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('child mode rejects caller-provided DB outside its own temporary workspace', () => {
  const result = spawnSync(process.execPath, [source, '--child', '--db', join(tmpdir(), 'telemetry.db')], {
    encoding: 'utf8', timeout: 3000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isolated temporary fixture databases/);
});

test('3-day/900k-sample short regression verifies backup overlaps live ACKs and restart durability', () => {
  // This is NOT a 60-120s soak: only two seconds of offered traffic, bounded
  // so GPU/performance work in other agents is not disrupted.
  const root = mkdtempSync(join(tmpdir(), 'p4-mixed-three-day-'));
  try {
    const output = join(root, 'three-day.json');
    const response = run(['--duration', '2', '--rate', '10', '--days', '3', '--out', output],
      18000, { allowSharedRunnerTiming: true });
    const report = JSON.parse(readFileSync(output, 'utf8'));
    // Never claim that shared hosted VM timing proves strict P4 performance.
    for (const gate of ['validOffered99_9pct', 'rssUnder512MiB', 'verifiedConcurrentBackup',
      'injectedFaultRecovery', 'durableSQLite']) assert.equal(report.gates[gate], true, gate);
    assert.equal(response.profile.seeds.sessions, 3000);
    assert.equal(report.profile.seeds.samples, 900000);
    assert.equal(report.ingestion.offered, 20);
    assert.equal(report.ingestion.acknowledged, 20);
    assert.equal(report.backup.verified, true);
    assert(report.backup.ackDuring > 0, 'concurrent write ACKs must occur while 3-day backup is running');
    assert.equal(report.gates.verifiedConcurrentBackup, true);
    assert.equal(report.fault.passed, true);
    assert.equal(report.verification.ok, true);
    assert.equal(report.verification.counts.sessions, 3005);
    assert.equal(report.verification.counts.samples, 900048);
    assert.equal(report.verification.counts.batches, 90016);
    assert.deepEqual(report.verification.orphanCounts, { samples: 0, events: 0, batches: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
