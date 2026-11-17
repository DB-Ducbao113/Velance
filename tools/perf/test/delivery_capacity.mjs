import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCapacityArgs, runDeliveryCapacity } from '../delivery_capacity.mjs';

test('CLI options are strict and enforce per-mode load, duration, and memory bounds', () => {
  assert.deepEqual(parseCapacityArgs([]), { durationSeconds: 10, rps: 10, concurrency: 16, out: null });
  assert.deepEqual(parseCapacityArgs(['--duration', '2s', '--rps', '3', '--concurrency', '1']),
    { durationSeconds: 2, rps: 3, concurrency: 1, out: null });
  assert.deepEqual(parseCapacityArgs(['--help']), { help: true });
  for (const values of [
    ['--duration', '31s'], ['--duration', '10'], ['--duration', '0s'], ['--duration', '-1s'],
    ['--rps', '0'], ['--rps', '41'], ['--rps', '10.5'], ['--concurrency', '33'],
    ['--concurrency', '0'], ['--rps', '1', '--rps', '2'], ['--out'], ['--what', '5'],
    ['--help', '--rps', '5']
  ]) assert.throws(() => parseCapacityArgs(values), Error, values.join(' '));
});

test('fixture-only P4 capacity records offered/sent/completed, HTTP headers, 304 and real body bytes', async t => {
  const base = mkdtempSync(join(tmpdir(), 'velance-p4-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const out = join(base, 'capacity.json');
  const result = await runDeliveryCapacity({ durationSeconds: 1, rps: 4, concurrency: 2, out });
  assert.equal(result.format, 'velance-p4-delivery-capacity/1');
  assert.equal(result.config.totalOfferedSteadyState, 12);
  assert.equal(result.config.separateConcurrencyProbeOffers, 2);
  assert.deepEqual(result.config.modes, ['uncached', 'warm', 'identity']);
  assert.equal(result.environment.host, '127.0.0.1');
  assert.equal(result.environment.clientAndServerInSameProcess, true);
  assert.equal(result.fixture.fileCount, 4);
  assert.equal(result.fixture.snapshotFiles, 4);
  assert.match(result.fixture.source, /generated/);
  assert(result.fixture.diskBefore.apparentBytes > result.fixture.sourceBytes);
  assert(result.fixture.diskAfter.apparentBytes > 0);
  assert.equal(result.fixture.diskBefore.regularFiles, result.fixture.diskAfter.regularFiles);
  assert.equal(result.priming.requests, 4);
  assert(result.priming.bodyBytes > 0);
  assert(result.priming.headers.html['content-encoding'] === 'br');
  assert(result.priming.headers.js['content-encoding'] === 'gzip');
  assert.equal(result.priming.headers.glb['content-encoding'], null);
  assert.equal(result.priming.headers.webp['content-encoding'], null);

  for (const mode of result.modes) {
    assert.equal(mode.load.offered, 4);
    assert.equal(mode.load.sent, 4);
    assert.equal(mode.load.completed, 4);
    assert.equal(mode.load.transportErrors, 0);
    assert.equal(mode.load.refusedBeforeSend, 0);
    assert.equal(mode.load.shedConcurrency + mode.load.shedSchedulerLag, 0);
    assert(mode.load.peakInFlight <= 2);
    assert(mode.load.observedCompletionRps <= 4, 'throughput denominator must include requested 1s window');
    assert.equal(mode.load.offered, mode.load.sent + mode.load.refusedBeforeSend);
    assert.equal(mode.load.sent, mode.load.completed + mode.load.transportErrors);
    assert.equal(mode.latencyMs.expectedStatus.samples, 4);
    assert(Number.isFinite(mode.latencyMs.completed.p50));
    assert(Number.isFinite(mode.latencyMs.completed.p95));
    assert(Number.isFinite(mode.latencyMs.completed.p99));
    assert(mode.latencyMs.completed.p99 >= mode.latencyMs.completed.p95);
    assert(mode.transfer.estimatedHttp1HeaderBytes > 0);
    assert.equal(mode.transfer.estimatedHttp1TotalBytes,
      mode.transfer.actualBodyBytes + mode.transfer.estimatedHttp1HeaderBytes);
    assert(mode.resources.processPeakRssBytes >= mode.resources.processRssBeforeBytes);
    assert(Number.isFinite(mode.resources.eventLoopDelayMs.p99));
    assert.deepEqual(mode.policyViolations, {});
    assert.equal(mode.httpErrors.status429, 0);
    assert.equal(mode.httpErrors.status503, 0);
    assert.equal(mode.httpErrors.other4xx5xx, 0);
    for (const sample of Object.values(mode.headersObserved)) {
      assert.equal(sample['cache-control'], 'public, max-age=31536000, immutable');
      assert.equal(sample.vary, 'Accept-Encoding');
      assert.match(sample.etag, /^"[a-f0-9]{64}-(?:br|gzip|identity)"$/);
      assert.equal(sample['x-content-type-options'], 'nosniff');
      assert.equal(sample['cross-origin-resource-policy'], 'same-origin');
    }
  }

  const [uncached, warm, identity] = result.modes;
  assert.equal(uncached.statusCounts[200], 4);
  assert.equal(uncached.statusCounts[304], 0);
  assert(uncached.transfer.actualBodyBytes > 0);
  assert.equal(uncached.headersObserved.html['content-encoding'], 'br');
  assert.equal(uncached.headersObserved.js['content-encoding'], 'gzip');
  assert.equal(uncached.headersObserved.glb['content-encoding'], null);
  assert.equal(uncached.headersObserved.webp['content-encoding'], null);

  assert.equal(warm.statusCounts[304], 4);
  assert.equal(warm.statusCounts[200], 0);
  assert.equal(warm.transfer.actualBodyBytes, 0);
  assert(warm.transfer.estimatedHttp1HeaderBytes > 0);
  assert.equal(warm.headersObserved.html['content-length'], null);
  assert.equal(warm.headersObserved.js['content-length'], null);
  assert.equal(warm.headersObserved.glb['content-length'], null);
  assert.equal(warm.headersObserved.webp['content-length'], null);
  assert.equal(identity.statusCounts[200], 4);
  assert(identity.transfer.actualBodyBytes > uncached.transfer.actualBodyBytes);
  assert.equal(identity.byResource.html.sent, 0);
  assert.equal(identity.byResource.js.sent, 0);
  assert.equal(identity.headersObserved.glb['content-encoding'], null);
  assert.equal(identity.byResource.glb.bodyBytes,
    identity.byResource.glb.completed * result.fixture.sizes['assets/models/synthetic.glb']);
  assert.equal(identity.byResource.webp.bodyBytes,
    identity.byResource.webp.completed * result.fixture.sizes['assets/images/synthetic/angle.webp']);

  assert.equal(result.concurrencyProbe.offered, 2);
  assert.equal(result.concurrencyProbe.sent, 2);
  assert.equal(result.concurrencyProbe.completed, 2);
  assert.equal(result.concurrencyProbe.clientRequestsDispatchedTogether, 2);
  assert.equal(result.concurrencyProbe.statuses[200], 2);
  assert.equal(result.concurrencyProbe.statuses[429], 0);
  assert.equal(result.concurrencyProbe.statuses[503], 0);
  assert(result.concurrencyProbe.actualBodyBytes > 2 * 300 * 1024);
  assert.equal(result.concurrencyProbe.actualBodyBytes, 2 * result.fixture.sizes['assets/models/synthetic.glb']);
  assert.deepEqual(result.concurrencyProbe.policyViolations, {});
  assert(result.concurrencyProbe.resources.processRssObservedMaxBytes >=
    result.concurrencyProbe.resources.processRssBeforeBytes);

  assert.deepEqual(result.upstreamOutage, { upstream: 'unavailable loopback port (no DB)',
    staticStatus: 200, staticComplete: true, telemetryStatus: 503, telemetryComplete: true, passed: true });
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), result);
});
