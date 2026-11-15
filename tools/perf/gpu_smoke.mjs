import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origin = process.env.TEST_ORIGIN || 'http://localhost:8090';
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shots = process.env.QA_SHOTS || mkdtempSync(join(tmpdir(), 'velance-gpu-'));
mkdirSync(shots, { recursive: true });
const backends = process.env.QA_BACKEND ? [process.env.QA_BACKEND] : ['webgpu', 'webgl'];
const browser = await puppeteer.launch({ executablePath: chrome, headless: false, args: ['--enable-unsafe-webgpu', '--window-size=1440,900'] });
try {
  for (const backend of backends) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${origin}/index.html?nointro&backend=${backend}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__NOIR_QA__?.stats()?.loaded === 16, { timeout: 120000 });
    const stats = await page.evaluate(() => window.__NOIR_QA__.stats());
    assert.equal(stats.backend, backend === 'webgpu' ? 'webgpu' : 'webgl2');
    assert.equal(stats.bays, 16);
    assert.equal(await page.evaluate(() => document.getElementById('navReview').hidden), true);
    assert.equal(await page.evaluate(() => document.getElementById('rowBtn').hidden), false);
    for (let i = 0; i < 16; i++) {
      if (i === 8) {
        await page.click('#rowBtn');
        await page.waitForFunction(() => !window.__NOIR_QA__.engine.flight);
        assert.equal(await page.evaluate(() => window.__NOIR_QA__.engine.row), 1);
        assert.match(await page.evaluate(() => document.getElementById('rowBtn').textContent), /FRONT ROW/);
      }
      await page.evaluate(i => window.__NOIR_QA__.engine.setFocus(i), i);
      await page.waitForFunction(i => Math.abs(window.__NOIR_QA__.engine.position - i) < .002, {}, i);
      await page.screenshot({ path: join(shots, `${backend}-home-${i}.png`) });
      await page.click('#selectCar');
      await page.waitForFunction(() => window.__NOIR_QA__.engine.controls?.enabled && Number(getComputedStyle(document.querySelector('.selected-view')).opacity) > .99 && document.querySelectorAll('.shot-section').length === 5 && [...document.querySelectorAll('.selected-headline > *, .selected-spec, .selected-actions > *')].every(el => Number(getComputedStyle(el).opacity) > .99));
      const before = await page.evaluate(() => {
        const q = window.__NOIR_QA__, e = q.engine, car = e.cars.get(q.selected);
        return car.userData.paintMats.map(m => ({ color: m.color.getHex(), map: m.map?.uuid ?? null, node: m.isNodeMaterial, paint: m.userData.isCarPaint }));
      });
      assert(before.length > 0 && before.every(m => m.node && m.paint), `Car ${i} has no TSL paint`);
      await page.click('[data-finish="rosso"]');
      assert(await page.evaluate(() => window.__NOIR_QA__.engine.cars.get(window.__NOIR_QA__.selected).userData.paintMats.every(m => m.color.getHexString() === '7c1418' && m.map === null)));
      await page.click('[data-finish="original"]');
      const restored = await page.evaluate(() => window.__NOIR_QA__.engine.cars.get(window.__NOIR_QA__.selected).userData.paintMats.map(m => ({ color: m.color.getHex(), map: m.map?.uuid ?? null, node: m.isNodeMaterial, paint: m.userData.isCarPaint })));
      assert.deepEqual(restored, before, `Factory paint failed to restore on car ${i}`);
      assert.equal(await page.evaluate(() => window.__NOIR_QA__.reviewCount), 5);
      assert.equal(await page.evaluate(() => window.__NOIR_QA__.boardCount), 5);
      assert.equal(await page.evaluate(() => window.__NOIR_QA__.galleryCanvases), 0);
      await page.screenshot({ path: join(shots, `${backend}-selected-${i}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.__NOIR_QA__.engine.flight && window.__NOIR_QA__.selected === null);
    }
    if (await page.evaluate(() => window.__NOIR_QA__.engine.row) !== 0) {
      await page.click('#rowBtn');
      await page.waitForFunction(() => !window.__NOIR_QA__.engine.flight);
    }
    await page.evaluate(() => window.__NOIR_QA__.engine.setFocus(0));
    await page.waitForFunction(() => window.__NOIR_QA__.engine.position < .002);
    await page.mouse.move(1000, 600);
    await page.mouse.down();
    await page.mouse.move(200, 600, { steps: 20 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__NOIR_QA__.engine.position > .998);
    assert.equal(await page.evaluate(() => window.__NOIR_QA__.engine.focus), 1, 'Drag advanced more than one bay');
    await page.click('#overviewBtn');
    await page.waitForFunction(() => !window.__NOIR_QA__.engine.flight);
    assert.equal(await page.evaluate(() => [...window.__NOIR_QA__.engine.cars.values()].filter(car => car.visible).length), 16);
    assert.equal(await page.evaluate(() => window.__NOIR_QA__.engine.reflectOn), false);
    await page.screenshot({ path: join(shots, `${backend}-overview.png`) });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__NOIR_QA__.engine.flight);
    await page.setViewport({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__NOIR_QA__?.stats()?.loaded === 16, { timeout: 120000 });
    assert(await page.evaluate(() => window.__NOIR_QA__.engine.basePixelRatio <= 1.5));
    await page.screenshot({ path: join(shots, `${backend}-mobile-home.png`) });
    await page.click('#selectCar');
    await page.waitForFunction(() => window.__NOIR_QA__.engine.controls?.enabled && Number(getComputedStyle(document.querySelector('.selected-view')).opacity) > .99 && [...document.querySelectorAll('.selected-spec, .selected-actions > *')].every(el => Number(getComputedStyle(el).opacity) > .99));
    await page.screenshot({ path: join(shots, `${backend}-mobile-selected.png`) });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.evaluate(() => window.__NOIR_QA__.engine.controls.enableZoom), false);
    assert.deepEqual(errors, []);
    console.log(`${backend}: 16 cars / two rows, original/rosso, editorial images, one-car drag, overview, mobile PASS`);
    await page.close();
  }
  const fallback = await browser.newPage();
  await fallback.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'gpu', { get: () => undefined }));
  await fallback.goto(`${origin}/index.html?nointro`, { waitUntil: 'load' });
  await fallback.waitForFunction(() => window.__NOIR_QA__?.engine, { timeout: 90000 });
  assert.equal(await fallback.evaluate(() => window.__NOIR_QA__.stats().backend), 'webgl2');
  console.log('Automatic WebGL2 fallback without navigator.gpu PASS');
  await fallback.close();
} finally {
  await browser.close();
  if (!process.env.QA_SHOTS) rmSync(shots, { recursive: true });
}
