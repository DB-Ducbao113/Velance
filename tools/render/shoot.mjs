import puppeteer from '../perf/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VEHICLES } from '../../src/data/vehicles.js';
const require = createRequire(import.meta.url);
const sharp = require('../optimize/node_modules/sharp/dist/index.cjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../');
const IDS = process.env.SHOT_IDS ? process.env.SHOT_IDS.split(',') : ['sf90xx', 'revuelto', 'aventador', 'porsche918', 'huayra', 'corvette', 'senna', 'mclaren765lt', 'porsche911'];
const NOSE_BACK = new Set(['mclarenp1', 'porsche911', 'aventador']);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false, args: ['--enable-unsafe-webgpu', '--window-size=1280,800'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERR', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('CONERR', m.text()); });
await page.goto('http://localhost:8090/tools/render/render.html', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000 });
for (const id of IDS) {
  const v = VEHICLES.find(x => x.id === id);
  const dir = join(ROOT, 'assets/images', id);
  mkdirSync(dir, { recursive: true });
  const shots = await page.evaluate((f, a, n) => window.__shoot(f, a, n), v.file, v.axis || 'z', NOSE_BACK.has(id));
  for (const [name, dataUrl] of shots) {
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    writeFileSync(join(dir, name + '.png'), png);
    await sharp(png).webp({ quality: 90, alphaQuality: 100 }).toFile(join(dir, name + '.webp'));
  }
  console.log('rendered', id, shots.length);
}
await browser.close();
console.log('DONE');