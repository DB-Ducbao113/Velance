import assert from 'node:assert/strict';
import test from 'node:test';
import { disposeModel, inputLifetime } from '../../../src/engine/resource-lifecycle.js';

test('shared textures, bitmaps, materials and geometry are released exactly once', () => {
  const calls = [];
  const resource = name => ({ dispose() { calls.push(name); } });
  const image = { close() { calls.push('image'); } };
  const texture = Object.assign(resource('texture'), { image, isTexture: true });
  const original = Object.assign(resource('original'), { image, isTexture: true });
  const material = Object.assign(resource('material'), { map: texture, userData: { baseMap: original } });
  const geo = resource('geo');
  const node = { geometry: geo, material: [material, material] };
  const root = { removeFromParent() { calls.push('detached'); }, traverse(fn) { fn(node); fn(node); } };
  disposeModel(root);
  assert.deepEqual(calls, ['detached', 'texture', 'original', 'material', 'geo', 'image']);
});

test('disposal detaches stage and window listeners and prevents late registrations', () => {
  const lifetime = inputLifetime(), stage = new EventTarget(), win = new EventTarget();
  let count = 0;
  const handler = () => count++;
  lifetime.listen(stage, 'pointerup', handler);
  lifetime.listen(win, 'resize', handler, { passive: true });
  stage.dispatchEvent(new Event('pointerup')); win.dispatchEvent(new Event('resize'));
  assert.equal(count, 2);
  lifetime.close(); lifetime.close();
  lifetime.listen(win, 'resize', handler);
  stage.dispatchEvent(new Event('pointerup')); win.dispatchEvent(new Event('resize'));
  assert.equal(count, 2);
});

test('instanced mesh ownership is released independently of shared geometry', () => {
  let instances = 0, geometries = 0;
  const geometry = {dispose() { geometries++; }};
  const one = {isInstancedMesh: true, geometry, dispose() { instances++; }};
  const two = {isInstancedMesh: true, geometry, dispose() { instances++; }};
  disposeModel({removeFromParent() {}, traverse(fn) {fn(one); fn(two); fn(one);}});
  assert.equal(instances, 2);
  assert.equal(geometries, 1);
});
