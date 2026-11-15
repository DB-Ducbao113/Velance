import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createCarPaintMaterial, PAINT_PRESETS } from 'tsl-carpaint';

const stage = document.getElementById('stage');
const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: new URLSearchParams(location.search).get('backend') === 'webgl' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.setClearColor(0x090d11);
await renderer.init();
stage.append(renderer.domElement);

const scene = new THREE.Scene();
const room = new RoomEnvironment();
room.position.y = 0;
const pmrem = new THREE.PMREMGenerator(renderer);
const environment = pmrem.fromScene(room, .04);
scene.environment = environment.texture;
scene.environmentIntensity = .8;
room.dispose();
pmrem.dispose();
const camera = new THREE.PerspectiveCamera(40, 1, .1, 30);
camera.position.set(2.8, 1.1, 3.9);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.enableZoom = false;
const source = new THREE.MeshPhysicalMaterial({ color: '#7c1418', metalness: .65, roughness: .26 });
const material = createCarPaintMaterial(source);
source.dispose();
const sample = new THREE.Mesh(new THREE.SphereGeometry(1.05, 96, 64), material);
sample.scale.set(1.15, .72, .9);
scene.add(sample);
const key = new THREE.DirectionalLight(0xffedd4, 2.4);
key.position.set(3, 4, 2);
scene.add(key, new THREE.HemisphereLight(0xc5d4e8, 0x141921, .5));

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
resize();
addEventListener('resize', resize);
const parameters = ['flakes', 'orangePeel', 'pearl'];
function sync() {
  for (const key of parameters) {
    document.getElementById(key).value = material.paint[key].value;
    document.getElementById(`${key}Value`).value = material.paint[key].value.toFixed(2);
  }
}
for (const key of parameters) document.getElementById(key).addEventListener('input', e => {
  material.paint[key].value = Number(e.target.value);
  sync();
});
document.getElementById('swatches').addEventListener('click', e => {
  const button = e.target.closest('[data-color]');
  if (!button) return;
  material.color.set(button.dataset.color);
  for (const b of button.parentElement.children) b.setAttribute('aria-pressed', String(b === button));
});
document.getElementById('presets').addEventListener('click', e => {
  const button = e.target.closest('[data-preset]');
  if (!button) return;
  const preset = PAINT_PRESETS[button.dataset.preset];
  for (const key of [...parameters, 'flakeDensity']) material.paint[key].value = preset[key];
  material.paint.pearlColor.value.set(preset.pearlColor);
  for (const b of button.parentElement.children) b.setAttribute('aria-pressed', String(b === button));
  sync();
});
await renderer.compileAsync(scene, camera);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
document.getElementById('status').textContent = 'DRAG TO ORBIT · LIVE UNIFORMS';
document.getElementById('backend').textContent = renderer.backend.isWebGPUBackend ? 'WEBGPU / WGSL' : 'WEBGL2 / GLSL';

window.__PAINT_QA__ = {
  renderer, scene, camera, material, sample,
  async capture() {
    const target = new THREE.RenderTarget(256, 256, { type: THREE.HalfFloatType });
    const aspect = camera.aspect;
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    renderer.setRenderTarget(target);
    try {
      renderer.render(scene, camera);
      const data = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256);
      return Array.from(data, value => THREE.DataUtils.fromHalfFloat(value));
    } finally {
      renderer.setRenderTarget(null);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      target.dispose();
    }
  }
};
