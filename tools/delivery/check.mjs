#!/usr/bin/env node
// P3 local-only gate: built-in syntax/native tests plus P2 regression.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const testDir = join(root, 'tools/delivery/test');
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) { console.error('P3 delivery check requires Node 24+'); process.exit(1); }
const tests = readdirSync(testDir).filter(name => name.endsWith('.mjs')).sort()
  .map(name => `tools/delivery/test/${name}`);
if (!tests.length) { console.error('P3 gate has no native test files'); process.exit(1); }
const syntax = ['tools/delivery/static.mjs', 'tools/delivery/release.mjs',
  'tools/delivery/server.mjs', 'tools/delivery/check.mjs',
  'tools/perf/delivery.mjs', 'tools/perf/release_switch.mjs', ...tests];
function run(args) {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log(`[delivery P3] Node ${process.version}, syntax files ${syntax.length}`);
for (const file of syntax) run(['--check', file]);
console.log(`[delivery P3] Native suites ${tests.length}`);
run(['--test', '--test-concurrency=1', ...tests]);
console.log('[delivery P3] Running existing P2 native gate');
run(['tools/ops/check.mjs']);
console.log('[delivery P3] Local gate passed');
