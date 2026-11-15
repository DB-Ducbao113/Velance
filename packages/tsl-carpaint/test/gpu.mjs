import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(new URL('../../../tools/perf/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = process.env.TEST_ORIGIN || 'http://localhost:8090';
const shots = process.env.QA_SHOTS || mkdtempSync(join(tmpdir(), 'tsl-carpaint-'));
const delta = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
const browser = await puppeteer.launch({ executablePath: chrome, headless: false, args: ['--enable-unsafe-webgpu', '--window-size=1280,900'] });
try {
  for (const backend of ['webgpu', 'webgl']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/packages/tsl-carpaint/demo/?backend=${backend}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__PAINT_QA__, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.__PAINT_QA__.renderer.backend.isWebGPUBackend === true), backend === 'webgpu');
    const capture = () => page.evaluate(() => window.__PAINT_QA__.capture());
    const baseline = await capture();
    assert(baseline.every(Number.isFinite), 'Non-finite output');
    assert(Math.max(...baseline.slice(0, 5000)) > .01, 'Empty render');
    await page.screenshot({ path: join(shots, `${backend}-demo.png`) });
    const version = await page.evaluate(() => window.__PAINT_QA__.material.version);
    await page.click('[data-color="#173a5e"]');
    const blue = await capture();
    assert(delta(baseline, blue) > .001, 'Swatch did not change pixels');
    await page.click('[data-color="#7c1418"]');
    const restored = await capture();
    assert(delta(baseline, restored) < .0001, 'Factory colour did not restore');
    for (const key of ['flakes', 'orangePeel', 'pearl']) {
      await page.evaluate(key => { window.__PAINT_QA__.material.paint[key].value = 1; }, key);
      const changed = await capture();
      assert(delta(baseline, changed) > 1e-8, `${key} did not affect rendering`);
      await page.evaluate(key => {
        const values = { flakes: .22, orangePeel: .35, pearl: .08 };
        window.__PAINT_QA__.material.paint[key].value = values[key];
      }, key);
    }
    assert.equal(await page.evaluate(() => window.__PAINT_QA__.material.version), version, 'Uniform edits rebuilt the material');
    await page.click('[data-preset="solid"]');
    assert.equal(await page.evaluate(() => window.__PAINT_QA__.material.paint.flakes.value), 0);
    await page.setViewport({ width: 390, height: 844 });
    await page.screenshot({ path: join(shots, `${backend}-mobile.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile horizontal overflow');
    assert.deepEqual(errors, []);
    console.log(`${backend}: finite HDR, live colour, restored colour, flakes, peel, pearl, stable material, responsive layout PASS`);
    await page.close();
  }
} finally {
  await browser.close();
  if (!process.env.QA_SHOTS) rmSync(shots, { recursive: true });
}
