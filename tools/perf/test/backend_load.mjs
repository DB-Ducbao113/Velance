import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { distribution, parseOptions, percentile } from '../backend_load.mjs';

const script = resolve(import.meta.dirname, '../backend_load.mjs');
function run(args, timeout = 30000) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout, maxBuffer: 2_000_000 });
  assert.equal(result.status, 0, `CLI ${args.join(' ')} failed: ${result.stderr || result.error?.message}`);
  return JSON.parse(result.stdout);
}

test('strict CLI parser, safe defaults and nearest-rank percentiles', () => {
  assert.deepEqual([parseOptions([]).duration, parseOptions([]).rate, parseOptions([]).days], [10, 10, 0]);
  assert.deepEqual([parseOptions(['--smoke']).duration, parseOptions(['--smoke']).rate,
    parseOptions(['--smoke']).days], [3, 5, 0]);
  for (const args of [['--duration', '0'], ['--duration', 'NaN'], ['--rate', '0'], ['--rate', '201'],
    ['--days', '-1'], ['--days', '31'], ['--rate', '5', '--rate', '5'], ['--smoke', '--days', '1'],
    ['--unsupported'], ['--out'], ['--duration', '2.5']]) assert.throws(() => parseOptions(args), args.join(' '));
  assert.equal(percentile([9, 1, 5, 3], .95), 9);
  assert.deepEqual(distribution([]), { n: 0, min: null, mean: null, p50: null, p95: null, p99: null, max: null });
  assert.equal(distribution([3, 1, 2]).p50, 2);
});

test('days=1 seed-only creates fresh temporary WAL fixture with exact 300k deterministic sample count', () => {
  const report = run(['--seed-only', '--days', '1']);
  assert.equal(report.mode, 'seed-only');
  assert.equal(report.profile.seedSessions, 1000);
  assert.equal(report.profile.seedSamples, 300000);
  assert.equal(report.verification.ok, true);
  assert.deepEqual(report.verification.counts, { sessions: 1000, samples: 300000, events: 2000, batches: 30000 });
});

test('normal 10/s run reports durable ACK receipts, response classifications and bounded output file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'velance-p4-test-'));
  try {
    const file = join(dir, 'report.json');
    const summary = run(['--duration', '1', '--rate', '10', '--days', '0', '--out', file]);
    const report = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(summary.mode, 'normal');
    assert.equal(report.ingest.offered, 10);
    assert.equal(report.ingest.acknowledged200, 10);
    assert.equal(report.ingest.localDropped, 0);
    assert.equal(report.ingest.timeout, 0);
    assert.equal(report.ingest.networkErrors, 0);
    assert.equal(report.verification.ok, true);
    assert.equal(report.verification.receiptsPersisted, 10);
    assert.equal(report.verification.counts.samples, 100);
    assert.equal(report.gates.mode, 'normal');
    assert.equal(report.dashboard.complete200, report.dashboard.count);
    assert(report.latencyMs.offeredCompleted.n === 10);
    assert(report.latencyMs.admitted.n === 10);
    assert(report.ingest.peakPending <= report.profile.maxPending);
    assert.equal('rawRequests' in report, false);
    assert(statSync(file).size < 50_000, 'measurement reports aggregate rather than dumping request bodies');
    const duplicate = spawnSync(process.execPath, [script, '--seed-only', '--out', file], { encoding: 'utf8' });
    assert.notEqual(duplicate.status, 0, 'output must not overwrite an existing report');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('100/s overload reports expected 429 without claiming offered-success gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'velance-p4-overload-'));
  try {
    const file = join(dir, 'overload.json');
    const report = run(['--duration', '3', '--rate', '100', '--days', '0', '--out', file]);
    const detail = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(report.mode, 'overload');
    assert.equal(detail.ingest.offered, 300);
    assert(detail.ingest.expected429 > 0, 'token bucket must reject sustained 100/s after its initial burst');
    assert.equal(detail.ingest.unexpected429, 0);
    assert.equal(detail.ingest.localDropped, 0);
    assert.equal(detail.ingest.timeout, 0);
    assert.equal(detail.ingest.acknowledged200 + detail.ingest.expected429, 300);
    assert.equal(detail.gates.validOfferedSuccess99_9pct, null);
    assert.equal(detail.gates.overall, null);
    assert.equal(detail.verification.ok, true);
    assert.equal(detail.verification.receiptsPersisted, detail.ingest.acknowledged200);
    assert.equal(detail.latencyMs.rejection429.n, detail.ingest.expected429);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('internal child cannot target an ordinary DB path', () => {
  const result = spawnSync(process.execPath, [script, '--child', '--db', join(tmpdir(), 'non-fixture.db')],
    { encoding: 'utf8', timeout: 3000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isolated temporary fixture/);
});
