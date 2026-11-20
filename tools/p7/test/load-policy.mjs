import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOrder, gpuPowerPreference } from '../../../src/engine/load-policy.js';

test('cold page loads only explicitly focused machine, never all models', () => {
  for (const focus of [0, 4, 7, 8, 15]) assert.deepEqual(loadOrder(focus, 16), [focus]);
});

test('explicit overview orders all 16 models without duplicate fetch intents', () => {
  for (const center of [0, 7, 8, 15]) {
    const all = loadOrder(center, 16, { all: true });
    assert.equal(all[0], center);
    assert.equal(all.length, 16);
    assert.deepEqual([...all].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i));
    const distances = all.map(i => Math.abs(i - center));
    assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
  }
});

test('invalid indices fail closed', () => {
  for (const [center, count] of [[-1, 16], [16, 16], [2.1, 16], [0, 0], [0, -1]]) {
    assert.throws(() => loadOrder(center, count), { name: 'RangeError', message: 'BAD_MODEL_INDEX' });
  }
});

test('constrained devices request a valid WebGPU power preference, not WebGL default', () => {
  assert.equal(gpuPowerPreference(true), 'low-power');
  assert.equal(gpuPowerPreference(false), 'high-performance');
});
