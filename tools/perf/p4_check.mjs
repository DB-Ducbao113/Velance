#!/usr/bin/env node
// Reproducible P4 safety/correctness gate. Heavy workload and headed GPU probes
// must be deliberately invoked separately, never silently run by this script.
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const node = process.execPath;
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) { console.error('[P4] requires Node >=24'); process.exit(1); }
const files = ['tools/perf/backend_load.mjs', 'tools/perf/delivery_capacity.mjs',
  'tools/perf/p4_browser.mjs', 'tools/perf/p4_multitab.mjs',
  'tools/perf/p4_user_journeys.mjs', 'tools/perf/p4_mixed_soak.mjs',
  'tools/perf/p4_acceptance.mjs', 'tools/perf/p4_extended_acceptance.mjs',
  'tools/perf/p4_check.mjs'];
const testDir = join(ROOT, 'tools/perf/test');
const tests = existsSync(testDir) ? readdirSync(testDir).filter(f => f.endsWith('.mjs')).sort()
  .map(f => `tools/perf/test/${f}`) : [];
function run(argv) {
  const result = spawnSync(node, argv, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`[P4] syntax ${files.length + tests.length} files; native P4 test suites ${tests.length}`);
for (const file of [...files, ...tests]) run(['--check', file]);
if (tests.length) run(['--test', '--test-concurrency=1', ...tests]);
console.log('[P4] P3 + P2 native regression');
run(['tools/delivery/check.mjs']);
console.log('[P4] native gate PASS; load/stress/Chrome remain explicit runs');
