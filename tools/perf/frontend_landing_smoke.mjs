#!/usr/bin/env node
// Verify the interactive Portal: animated fog, automatic ignition and ENTER.
// The normal app bypasses the entrance for webdriver; only this local QA
// restores the real visitor view.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8090';
const shotDir = process.env.QA_SHOT_DIR;
const backend = process.env.QA_BACKEND || 'webgl';
if (shotDir) mkdirSync(shotDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--window-size=1440,900']
});
try {
  for (const [name, viewport, reduced] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }, false],
    ['small', { width: 320, height: 640, isMobile: true, hasTouch: true }, false],
    ['reduced', { width: 390, height: 844, isMobile: true, hasTouch: true }, true]
  ]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setViewport(viewport);
    await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'webdriver', {
      configurable: true, get: () => false
    }));
    if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(`${origin}/index.html?notelemetry&backend=${backend}`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => {
      const img = document.querySelector('.portal-image');
      return img && img.complete && img.naturalWidth > 0;
    }, { timeout: 30000 });
    assert(await page.evaluate(() => document.querySelector('main').inert && document.querySelector('#topbar').inert && document.activeElement.id === 'gateEnter'), `${name}: entrance must be modal and focused`);
    for (const key of ['Tab', 'Shift+Tab', 'ArrowRight', 'Escape']) {
      if (key === 'Shift+Tab') {
        await page.keyboard.down('Shift');
        try { await page.keyboard.press('Tab'); } finally { await page.keyboard.up('Shift'); }
      } else await page.keyboard.press(key);
      assert(await page.evaluate(() => document.querySelector('#gate') && document.activeElement.id === 'gateEnter'), `${name}: ${key} escaped portal focus`);
    }
    if (!reduced) await new Promise(resolve => setTimeout(resolve, 1700));
    const visual = await page.evaluate(() => {
      const gate = document.querySelector('#gate');
      const car = document.querySelector('.portal-image');
      const picture = car.currentSrc;
      const title = document.querySelector('.gate-hero-type');
      const btn = document.querySelector('#gateEnter');
      const carBox = car.getBoundingClientRect(), titleBox = title.getBoundingClientRect();
      return {
        displayed: getComputedStyle(gate).visibility === 'visible',
        carWidth: car.naturalWidth, carHeight: car.naturalHeight,
        carX: carBox.x, carVisibleWidth: Math.min(carBox.right, innerWidth) - Math.max(carBox.left, 0),
        carVisibleHeight: Math.min(carBox.bottom, innerHeight) - Math.max(carBox.top, 0),
        titleWidth: titleBox.width, titleText: title.textContent.trim(),
        titleOpacity: Number(getComputedStyle(title).opacity),
        image: picture.split('/').at(-1), labelCount: gate.querySelectorAll('p').length,
        fogWidth: gate.querySelector('#portalFog').width,
        ignited: gate.dataset.ignited,
        lampOpacity: Number(getComputedStyle(gate.querySelector('.portal-lights')).opacity),
        buttonVisible: btn.getBoundingClientRect().bottom < innerHeight && btn.getBoundingClientRect().top > 0,
        scrollX: document.documentElement.scrollWidth - innerWidth
      };
    });
    assert(visual.displayed, `${name}: gate hidden`);
    assert.equal(visual.titleText, 'VÉLANCE');
    assert(visual.titleOpacity > .95, `${name}: hero type invisible`);
    assert.equal(visual.labelCount, 0, `${name}: landing has redundant paragraphs`);
    assert(visual.carVisibleWidth > viewport.width * .75, `${name}: hero car not dominant`);
    assert(visual.carVisibleHeight > viewport.height * .25, `${name}: hero car too small`);
    assert(visual.buttonVisible, `${name}: ENTER button is offscreen`);
    assert(visual.scrollX <= 0, `${name}: horizontal overflow`);
    assert.match(visual.image, /^portal-(1600|2560)\.webp$/);
    assert(visual.fogWidth >= 640);
    await page.waitForFunction(() => document.querySelector('#gate').dataset.ignited === 'true');
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.portal-lights')).opacity) > .96);
    assert.equal(await page.$$eval('#gate button', buttons => buttons.map(b => b.id).join(',')), 'gateEnter');
    const fog = () => page.$eval('#portalFog', c => {
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let alpha = 0, hash = 0;
      for (let i = 3; i < data.length; i += 16) {
        alpha += data[i]; hash = (Math.imul(hash, 31) + data[i]) | 0;
      }
      return { alpha, hash };
    });
    const first = await fog();
    assert(first.alpha > 1000, 'fog must actually draw');
    await new Promise(resolve => setTimeout(resolve, 620));
    const second = await fog();
    if (reduced) assert.equal(first.hash, second.hash, 'reduced motion fog must stay still');
    else assert.notEqual(first.hash, second.hash, 'fog pixels must evolve');
    if (name === 'desktop' && !reduced) {
      // Observe two complete automatic off/on sequences without any input.
      // Check the rendered opacity as well as the light control state.
      for (let cycle = 0; cycle < 2; cycle++) {
        await page.waitForFunction(() => document.querySelector('#gate').dataset.ignited === 'false', { timeout: 8000 });
        await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.portal-lights')).opacity) < .04, { timeout: 2000 });
        if (shotDir) await page.screenshot({ path: join(shotDir, 'portal-lamps-off.png') });
        await page.waitForFunction(() => document.querySelector('#gate').dataset.ignited === 'true', { timeout: 4000 });
        await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.portal-lights')).opacity) > .96, { timeout: 2000 });
      }
      console.log('PASS automatic ignition: two consecutive off/on cycles');
    }
    if (reduced) {
      await new Promise(resolve => setTimeout(resolve, 4500));
      assert.equal(await page.$eval('#gate', x => x.dataset.ignited), 'true');
      assert.deepEqual(await fog(), second, 'reduced motion remains static');
    }
    // Enter while dark to verify that ENTER forces the lights on.
    if (!reduced) await page.waitForFunction(() => document.querySelector('#gate').dataset.ignited === 'false', { timeout: 8000 });
    assert.equal(await page.$('#velance-telemetry-settings'), null);
    if (shotDir) await page.screenshot({ path: join(shotDir, `landing-${name}.png`) });
    await page.keyboard.press('Enter');
    if (!reduced) await page.waitForFunction(() => document.querySelector('#gate')?.dataset.ignited === 'true', { timeout: 800 });
    await page.waitForFunction(() => !document.querySelector('#gate'), { timeout: 10000 });
    assert(await page.evaluate(() => !document.querySelector('main').inert && !document.querySelector('#topbar').inert && document.activeElement.id === 'brandLink'), `${name}: focus/inert state not restored`);
    await page.waitForFunction(() => !!window.__VELANCE_QA__?.engine?.initialReady, { timeout: 90000 });
    assert.equal(await page.$('#velance-telemetry-settings'), null);
    assert.equal(await page.evaluate(() => window.__VELANCE_QA__.stats().backend), backend === 'webgpu' ? 'webgpu' : 'webgl2');
    if (name === 'desktop') {
      await page.waitForFunction(() => !window.__VELANCE_QA__.engine.flight, { timeout: 60000 });
      assert.equal(await page.evaluate(() => window.__VELANCE_QA__.overview), true);
      assert.equal(await page.evaluate(() => window.__VELANCE_QA__.engine.cars.size), 16);
      await page.click('.bay-label.is-loaded:not(.is-off)');
      await page.waitForFunction(() => window.__VELANCE_QA__.engine.controls?.enabled, { timeout: 60000 });
      await page.waitForFunction(() => document.querySelectorAll('.board-item').length > 0, { timeout: 10000 });
      assert.equal(await page.$$('.shot-section').then(x=>x.length), 0);
      assert.equal(await page.$eval('#navReview', x=>x.hidden), true);
      assert.equal(await page.$eval('#navBoard', x=>x.hidden), false);
    }
    assert.deepEqual(errors, [], `${name}: browser errors`);
    console.log(`PASS ${backend} ${name}: live Portal fog + ignition ${visual.image}, minimal copy, no overflow, ENTER works`);
    await page.close();
  }
} finally {
  await browser.close();
}
