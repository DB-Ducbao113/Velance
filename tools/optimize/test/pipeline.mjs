import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import { bakeStatic } from '../bake-static.mjs';
import { checkBudget, LIMITS } from '../budget.mjs';

function triangle(document) {
  const buffer = document.createBuffer();
  const position = document.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const normal = document.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])).setBuffer(buffer);
  return document.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', normal);
}

test('static transform is baked once with unit normals', () => {
  const document = new Document();
  const scene = document.createScene();
  const primitive = triangle(document);
  scene.addChild(document.createNode().setTranslation([2, 3, 4]).setScale([2, 1, 3]).setMesh(document.createMesh().addPrimitive(primitive)));
  bakeStatic(document);
  const baked = scene.listChildren()[0].getMesh().listPrimitives()[0];
  assert.deepEqual(baked.getAttribute('POSITION').getElement(1, []), [4, 3, 4]);
  assert.deepEqual(baked.getAttribute('NORMAL').getElement(0, []), [0, 0, 1]);
  assert.deepEqual(scene.listChildren()[0].getTranslation(), [0, 0, 0]);
  assert.deepEqual(primitive.getAttribute('POSITION').getElement(1, []), [1, 0, 0]);
});

test('bind-pose skin is baked into static world-space positions', () => {
  const document = new Document();
  const scene = document.createScene();
  const primitive = triangle(document);
  const buffer = document.getRoot().listBuffers()[0];
  const joints = document.createAccessor().setType('VEC4').setArray(new Uint16Array(12)).setBuffer(buffer);
  const weights = document.createAccessor().setType('VEC4').setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])).setBuffer(buffer);
  primitive.setAttribute('JOINTS_0', joints).setAttribute('WEIGHTS_0', weights);
  const joint = document.createNode().setTranslation([5, 0, 0]);
  const skin = document.createSkin().addJoint(joint);
  scene.addChild(joint).addChild(document.createNode().setSkin(skin).setMesh(document.createMesh().addPrimitive(primitive)));
  bakeStatic(document);
  const node = scene.listChildren()[0];
  const baked = node.getMesh().listPrimitives()[0];
  assert.equal(node.getSkin(), null);
  assert.equal(baked.getAttribute('JOINTS_0'), null);
  assert.deepEqual(baked.getAttribute('POSITION').getElement(1, []), [6, 0, 0]);
});

test('payload and geometry budgets reject oversized assets', () => {
  const valid = { file: 'car.glb', bytes: 1024, triangles: 100, materials: 1 };
  assert.deepEqual(checkBudget([valid]).failures, []);
  assert(checkBudget([{ ...valid, bytes: LIMITS.modelBytes + 1 }]).failures.length > 0);
  assert(checkBudget([{ ...valid, triangles: LIMITS.modelTriangles + 1 }]).failures.length > 0);
});
