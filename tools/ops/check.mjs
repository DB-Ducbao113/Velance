#!/usr/bin/env node
// P2 local quality gate: syntax + native tests only; never opens the real telemetry DB.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const testDir = join(root, 'tools/ops/test');
const nodeMajor = Number(process.versions.node.split('.')[0]);

if (nodeMajor < 24) {
  console.error(`Fleet Ops requires Node.js 24+ (found ${process.versions.node}).`);
  process.exit(1);
}

const tests = readdirSync(testDir).filter(name => name.endsWith('.mjs')).sort()
  .map(name => `tools/ops/test/${name}`);
if (!tests.length) {
  console.error('No Fleet Ops native test files found.');
  process.exit(1);
}

const syntaxFiles = [
  'tools/ops/server.mjs',
  'tools/ops/store.mjs',
  'tools/ops/db-worker.mjs',
  'tools/ops/operations.mjs',
  'tools/ops/check.mjs',
  'src/telemetry/collector.js',
  'ops/ops.js',
  'tools/ops/test/fixtures/crash-child.mjs',
  ...tests
];

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`[Fleet Ops] Node ${process.versions.node}: checking ${syntaxFiles.length} JavaScript files`);
for (const file of syntaxFiles) run(['--check', file]);
console.log(`[Fleet Ops] Running ${tests.length} native test files (isolated fixtures)`);
run(['--test', '--test-concurrency=1', ...tests]);
console.log('[Fleet Ops] Local syntax and native tests passed.');
