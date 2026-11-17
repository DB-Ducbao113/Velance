// Headed Chrome test of an old open document across release activation/rollback.
// All releases and server processes are disposable local fixtures.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createDeliveryServer } from '../delivery/server.mjs';
import { createSnapshot, activateRelease, rollbackRelease } from '../delivery/release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(ROOT, process.argv[2] ?? 'tools/perf/results/delivery-release-switch.json');
const temp = mkdtempSync(join(tmpdir(), 'velance-release-browser-'));
const sourceRoot = join(temp, 'source'), storeDir = join(temp, 'store');
mkdirSync(sourceRoot);
function put(file, text) {
  const target = join(sourceRoot, file); mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}
function source(version) {
  put('index.html', `<!doctype html><title>release-${version}</title><script type="module" src="./src/app.js"></script>`);
  put('src/app.js', `window.__releaseCode = "${version}";`);
  put('src/late.js', `export const release = "${version}";`);
}
let server, browser;
try {
  source('A');
  const first = await createSnapshot({ sourceRoot, storeDir });
  await activateRelease({ storeDir, id: first.id });
  server = createDeliveryServer({ storeDir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false, args: ['--window-size=1024,768'] });
  const oldTab = await browser.newPage();
  await oldTab.goto(origin + '/', { waitUntil: 'load' });
  await oldTab.waitForFunction(() => window.__releaseCode === 'A');
  assert.equal(new URL(oldTab.url()).pathname, `/r/${first.id}/index.html`);

  source('B');
  const second = await createSnapshot({ sourceRoot, storeDir });
  await activateRelease({ storeDir, id: second.id });
  assert.equal(await oldTab.evaluate(() => window.__releaseCode), 'A');
  const oldLate = await oldTab.evaluate(async () => (await import('./src/late.js')).release);
  assert.equal(oldLate, 'A', 'Existing open page must import from old release');

  const newTab = await browser.newPage();
  await newTab.goto(origin + '/', { waitUntil: 'load' });
  await newTab.waitForFunction(() => window.__releaseCode === 'B');
  assert.equal(new URL(newTab.url()).pathname, `/r/${second.id}/index.html`);
  assert.equal(await newTab.evaluate(async () => (await import('./src/late.js')).release), 'B');

  await rollbackRelease({ storeDir });
  assert.equal(await newTab.evaluate(() => window.__releaseCode), 'B', 'Rollback must not replace existing DOM');
  const afterRollback = await browser.newPage();
  await afterRollback.goto(origin + '/', { waitUntil: 'load' });
  await afterRollback.waitForFunction(() => window.__releaseCode === 'A');
  assert.equal(new URL(afterRollback.url()).pathname, `/r/${first.id}/index.html`);
  assert.equal(await afterRollback.evaluate(async () => (await import('./src/late.js')).release), 'A');
  assert.equal(await newTab.evaluate(async () => (await import('./src/late.js')).release), 'B');

  const evidence = { format: 'velance-release-browser-switch/1', recordedAtUtc: new Date().toISOString(),
    chrome: await browser.version(), oldRelease: first.id, newRelease: second.id,
    checks: { oldTabAfterActivation: 'A', newTabAfterActivation: 'B',
      rollbackNewNavigation: 'A', stillOpenNewTabAfterRollback: 'B', allDynamicImportsVersioned: true },
    localOnly: true, syntheticSource: true };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} finally {
  if (browser) await browser.close();
  if (server?.listening) await server.shutdown();
  rmSync(temp, { recursive: true, force: true });
}
