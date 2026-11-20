/**
 * VÉLANCE V11 — the showroom is one real perspective scene on WebGPU
 * (three.js WebGPURenderer with automatic WebGL2 fallback, TSL node materials).
 * Architecture (floor, walls, columns, slatted ceiling, LED coves) is modeled
 * in meters; eight native GLBs park wheels-on-floor in marked bays.
 * Home: entrance camera, horizontal drag pans the hall with eased snapping.
 * Selected: other machines fade out, camera flies in, orbit on the left.
 */
import * as THREE from 'three';
import {
  Fn, uniform, float, vec3, vec4, mat3, mix, smoothstep, uv, texture, reflector, color as tslColor,
  materialColor, materialOpacity, vertexColor, instancedBufferAttribute,
  blendOverlay, acesFilmicToneMapping, sRGBTransferOETF, sRGBTransferEOTF
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createCarPaintMaterial } from 'tsl-carpaint';
import { loadOrder, gpuPowerPreference } from './load-policy.js';
import { modelResources, disposeModel, disposeResources, inputLifetime } from './resource-lifecycle.js';

const BAY_W = 6.4;
const CAR_LEN = 4.6;
const CAR_Z = -5.3;
const WALL_Z = -8.0;
const HALL_DEPTH = 17.2;
const CEIL_Y = 5.35;
const bayX = i => ((i % 8) - 3.5) * BAY_W;
const rowOf = i => (i < 8 ? 0 : 1);
const carZ = i => (i < 8 ? CAR_Z : -CAR_Z);
const NOSE_BACK = new Set(['mclarenp1', 'aventador']);
const HALL_W = 8 * BAY_W + 5;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeInOut = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
// The legacy cubic ease reached 3x average speed halfway through each flight.
// Smoothstep peaks at 1.5x and has zero velocity at both ends.
const cameraEase = t => t * t * (3 - 2 * t);
// C2 easing: both velocity AND acceleration are zero at the endpoints.
// The ordinary cubic easing joins with a nonzero acceleration and can feel
// abrupt when a virtual dolly is near a car.
const cinemaEase = t => t * t * t * (t * (t * 6 - 15) + 10);
const FLIGHT_SECONDS = Object.freeze({
  row: 1.6, overview: 1.9, select: 2.8, return: 1.65,
  entrance: 8.6, entranceHold: 4.2
});
const bayRevealOrder = i => (i % 8) * 2 + rowOf(i);
const flightSeconds = (from, to, minimum) => Math.max(minimum, from.distanceTo(to) / 9);
// Smooth spatial arc with zero velocity at the endpoints; avoids turning a
// direct linear dolly into a hard stop when the hero framing takes over.
function cubicPoint(out, a, b, c, d, t) {
  const s = 1 - t;
  return out.copy(a).multiplyScalar(s * s * s)
    .addScaledVector(b, 3 * s * s * t)
    .addScaledVector(c, 3 * s * t * t)
    .addScaledVector(d, t * t * t);
}
// Bézier's parameter is not distance: equal parameter steps can cross very
// different distances. Precompute cumulative arc lengths once per flight.
function cameraArcLut(a, b, c, d, samples = 72) {
  const positions = new Float32Array(samples + 1);
  const prev = a.clone(), current = new THREE.Vector3();
  let length = 0;
  for (let i = 1; i <= samples; i++) {
    cubicPoint(current, a, b, c, d, i / samples);
    length += prev.distanceTo(current);
    positions[i] = length;
    prev.copy(current);
  }
  return { positions, length, samples };
}
function arcParameter(lut, fraction) {
  if (fraction <= 0 || lut.length < 1e-6) return 0;
  if (fraction >= 1) return 1;
  const distance = fraction * lut.length;
  let lo = 0, hi = lut.samples;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (lut.positions[mid] < distance) lo = mid; else hi = mid;
  }
  return (lo + (distance - lut.positions[lo]) /
    Math.max(1e-8, lut.positions[hi] - lut.positions[lo])) / lut.samples;
}

const EXPOSURE = 1.12;
// HDR blending precedes tone mapping, so translucent layers need lower weights.
const K_ADD = .3, K_SMOKE = .35, K_LINE = .5;
const FOG_HOME = .02, FOG_OVERVIEW = .011;
const SHADOW_OPACITY = .65;

const ACES_IN = new THREE.Matrix3().set(.59719, .35458, .04823, .07600, .90834, .01566, .02840, .13383, .83777);
const ACES_OUT = new THREE.Matrix3().set(1.60475, -.53108, -.07367, -.10208, 1.10813, -.00605, -.00327, -.07276, 1.07602);
const ACES_IN_INV = ACES_IN.clone().invert();
const ACES_OUT_INV = ACES_OUT.clone().invert();
const toDisplay = rgb => sRGBTransferOETF(acesFilmicToneMapping(rgb, float(EXPOSURE)));
// Invert the output transform to composite the floor in display space.
const fromDisplay = Fn(([display]) => {
  const y = mat3(ACES_OUT_INV).mul(sRGBTransferEOTF(display)).clamp(0, 1);
  const a = y.mul(.983729).sub(1), b = y.mul(.432951).sub(.0245786), c = y.mul(.238081).add(.000090537);
  const x = b.add(b.mul(b).sub(a.mul(c).mul(4)).sqrt()).div(a.mul(-2));
  return mat3(ACES_IN_INV).mul(x).mul(.6 / EXPOSURE);
});
function displayToLinear(hex) {
  const rrtInverse = y => {
    y = clamp(y, 0, 1);
    const a = .983729 * y - 1, b = .432951 * y - .0245786, c = .238081 * y + .000090537;
    return (b + Math.sqrt(b * b - 4 * a * c)) / (-2 * a);
  };
  const v = new THREE.Vector3().setFromColor(new THREE.Color(hex)).applyMatrix3(ACES_OUT_INV);
  v.set(rrtInverse(v.x), rrtInverse(v.y), rrtInverse(v.z)).applyMatrix3(ACES_IN_INV).multiplyScalar(.6 / EXPOSURE);
  return new THREE.Color(v.x, v.y, v.z);
}
// Decals precede fading cars in the opaque list to avoid silhouette holes.
function floorDecal(material) {
  material.transparent = false;
  material.depthWrite = false;
  if (material.blending === THREE.NormalBlending) {
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.SrcAlphaFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
  }
  return material;
}
// Classic materials share one graph; opaque vertex alpha must not reach blending.
const OPAQUE_COLOR = vec4(materialColor.rgb.mul(vertexColor().rgb), 1);
function fadeReady(m) {
  m.userData.baseOpacity = m.opacity;
  if (m.transparent || m.alphaTest > 0) return;
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.SrcAlphaFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  if (!m.isNodeMaterial) {
    m.colorNode = OPAQUE_COLOR;
    m.vertexColors = false;
  }
  m.opacity = m.userData.baseOpacity = 1;
}
/* compileAsync() collects through frustum culling; lift it for the call. */
function cullOff(root) {
  const lifted = [];
  root.traverse(n => { if (n.frustumCulled && (n.isMesh || n.isSprite)) { n.frustumCulled = false; lifted.push(n); } });
  return () => { for (const n of lifted) n.frustumCulled = true; };
}

function canvasTexture(size, draw, repeat) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
function marbleTexture(base, vein, repeat) {
  return canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 26; i++) {
      ctx.strokeStyle = vein; ctx.globalAlpha = .04 + rnd() * .09; ctx.lineWidth = .6 + rnd() * 1.6;
      ctx.beginPath();
      let x = rnd() * s, y = rnd() * s; ctx.moveTo(x, y);
      for (let k = 0; k < 5; k++) { x += (rnd() - .5) * s * .5; y += (rnd() - .35) * s * .3; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    ctx.globalAlpha = .5; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, s, s);
    ctx.globalAlpha = 1;
  }, repeat);
}
function radialTexture(inner, outer, alphaCurve = null) {
  return canvasTexture(256, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, s * .04, s / 2, s / 2, s / 2);
    g.addColorStop(0, inner); g.addColorStop(1, outer);
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    if (!alphaCurve) return;
    const img = ctx.getImageData(0, 0, s, s);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = Math.round(255 * alphaCurve(img.data[i] / 255));
    ctx.putImageData(img, 0, 0);
  });
}
function washTexture() {
  return canvasTexture(256, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s * .12, s * .02, s / 2, s * .42, s * .62);
    g.addColorStop(0, 'rgba(255,214,160,.85)');
    g.addColorStop(.45, 'rgba(255,196,130,.28)');
    g.addColorStop(1, 'rgba(255,190,120,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  });
}
function textTexture(text, { size = 256, font = '600 120px Georgia, serif', color = 'rgba(238,220,190,.92)', metallic = false } = {}) {
  return canvasTexture(size, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    if (metallic) {
      const g = ctx.createLinearGradient(0, s * .32, 0, s * .68);
      g.addColorStop(0, '#f8ead0'); g.addColorStop(.3, '#e6cba0'); g.addColorStop(.52, '#a08055'); g.addColorStop(.74, '#f2dfb8'); g.addColorStop(1, '#c9a877');
      ctx.fillStyle = g;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '12px';
    } else ctx.fillStyle = color;
    ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, s / 2, s / 2);
  });
}
function smokeTexture() {
  return canvasTexture(256, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 26; i++) {
      const x = s * (.2 + rnd() * .6), y = s * (.25 + rnd() * .5), r = s * (.08 + rnd() * .2);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(214,219,226,.16)');
      g.addColorStop(1, 'rgba(214,219,226,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
  });
}
function shaftTexture() {
  return canvasTexture(128, (ctx, s) => {
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0, 'rgba(255,214,160,.5)');
    g.addColorStop(.5, 'rgba(255,205,150,.16)');
    g.addColorStop(1, 'rgba(255,200,140,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  });
}

function normalise(gltfScene, vehicle) {
  gltfScene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(gltfScene);
  if (box.isEmpty()) throw new Error('GLB has no visible mesh');
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const holder = new THREE.Group();
  const scale = CAR_LEN / Math.max(size.x, size.z, .001);
  holder.scale.setScalar(scale);
  gltfScene.position.set(-center.x, -box.min.y, -center.z);
  holder.add(gltfScene);
  if (vehicle.axis === 'x') holder.rotation.y = -Math.PI / 2;
  return holder;
}

export class GarageShowroom {
  /* WebGPU first; three.js drops to WebGL2 by itself, or on ?backend=webgl. */
  static async create(options) {
    const showroom = new GarageShowroom(options);
    try { await showroom.init(); } catch (error) { await showroom.dispose(); throw error; }
    return showroom;
  }
  constructor({ stage, labelHost, vehicles, focus = 0, reduced = false, preloadEntrance = false, onProgress = () => {}, onReady = () => {}, onError = () => {}, onFocus = () => {}, onSelect = () => {}, onOverview = () => {}, onDetailReady = () => {}, onDetailError = () => {} }) {
    this.stage = stage; this.labelHost = labelHost; this.vehicles = vehicles;
    this.reduced = reduced; this.onProgress = onProgress; this.onReady = onReady;
    this.onError = onError; this.onFocus = onFocus; this.onSelect = onSelect; this.onOverview = onOverview;
    this.onDetailReady=onDetailReady;this.onDetailError=onDetailError;
    this.mobile = matchMedia('(max-width:620px)').matches;
    this.mode = 'home';
    this.bayCount = 16;
    this.perRow = 8;
    // Both rows now hold real machines (front 01-08, rear 09-16); home browsing
    // stays inside one row at a time and the REAR ROW control flips between them.
    this.homeCount = this.bayCount;
    this.row = rowOf(focus); this.overview = false; this.ovPan = 0; this.ovTarget = 0; this.ovLimit = 8;
    this.ovHover = null; this.ovDrift = 0; this.ovOpenAt = 0; this.ovSweepX = 0;
    this.parked = 0;
    this.position = focus; this.target = focus; this.focus = focus;
    this.drag = null; this.dragged = false; this.suppressUntil = 0;
    this.cars = new Map(); this.fades = new Map(); this.labels = []; this.placeholders = new Map();
    this.paintChoice = new Map();
    this.queue = []; this.queued = new Set(); this.loading = false;
    this.activeLoad = null; this.loadFailures = new Set();
    this.preloadEntrance = preloadEntrance; this.entrancePrepared = false;
    // The actual landing anticipates the sixteen-bay reveal. Direct gallery
    // visits still request only the focused model until an explicit overview.
    this.buffers = new Map(); this.dlControllers = new Set();
    this.dlActive = 0; this.dlWaiters = []; this.dlLimit = 2;
    this.detailEpoch=0;this.detailTask=Promise.resolve();this.detailResident=null;this.pendingDetail=null;this.detailAbort=null;
    this.initialReady = false;
    this.loader = new GLTFLoader(); this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.loadTimes = {}; this.t0 = performance.now(); this.firstFrameAt = null;
    this.flight = null; this.selected = null;
    this.cinema = false; this.lightReveal = null;
    this.frameTimes = []; this.cadence = []; this.fps = null; this.lastDraw = 0; this.lastNow = 0;
    this.disposed = false;
    this.inputLifetime = inputLifetime();
    this.queueTask = Promise.resolve();
    this.compileQueue = Promise.resolve();
    this.reflectOn = true; this.reflectorDraws = 0; this.lastDrawCalls = 0; this.lastTriangles = 0;
    const ua=navigator.userAgent||'';
    this.memoryConstrained=this.mobile||(/AppleWebKit/.test(ua)&&!/(Chrome|Chromium|Edg|OPR)/.test(ua))||(navigator.deviceMemory>0&&navigator.deviceMemory<=4);
    this.pixelBudget=this.memoryConstrained?1500000:2500000;
    this.basePixelRatio = Math.min(devicePixelRatio || 1, this.memoryConstrained ? 1.25 : 1.5);
    this.maxPixelRatio=this.basePixelRatio;
    this.pixelRatio = this.basePixelRatio; this.ratioCooldown = 0;
    this.reflCam = null; this.reflSkip = false; this.reflDirty = true;
    this.lastOrbitAt = 0; this.lastSize = { w: 0, h: 0, pr: 0 };
    this.autoShot = null;
    this.studioActive = false;
    this.uploaded = new WeakSet();

    this.renderer = new THREE.WebGPURenderer({
      antialias: !this.memoryConstrained, alpha: false, powerPreference: gpuPowerPreference(this.memoryConstrained),
      forceWebGL: new URLSearchParams(location.search).get('backend') === 'webgl'
    });
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(displayToLinear(0x05070a), 1);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'garage-canvas';
  }
  async init() {
    await this.renderer.init();
    if (this.disposed) return;
    this.backend = this.renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
    // WebGL2 pays double for MSAA + full retina pixels; cap it harder there.
    if (this.backend === 'webgl2' && !this.mobile) {
      this.basePixelRatio = Math.min(this.basePixelRatio, 1.5);
      this.pixelRatio = this.basePixelRatio;
      this.renderer.setPixelRatio(this.basePixelRatio);
    }
    MeshoptDecoder.useWorkers(this.memoryConstrained ? 1 : 2);
    this.ktx2 = new KTX2Loader().setTranscoderPath(new URL('../../vendor/three/addons/libs/basis/', import.meta.url).href).setWorkerLimit(this.mobile ? 1 : 2).detectSupport(this.renderer);
    this.loader.setKTX2Loader(this.ktx2);
    this.stage.prepend(this.canvas);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05070a, FOG_HOME);
    this.camera = new THREE.PerspectiveCamera(this.mobile ? 60 : 50, 1, .1, 120);
    this.scene.add(this.camera);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    room.position.y = 0;
    this.envTarget=pmrem.fromScene(room, .04);this.env=this.envTarget.texture;
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.env;
    this.scene.environmentIntensity = .29;

    this.buildArchitecture();
    this.buildStudio();
    this.studioCurtain = document.createElement('div');
    this.studioCurtain.className = 'studio-curtain';
    this.studioCurtain.setAttribute('aria-hidden', 'true');
    this.stage.append(this.studioCurtain);
    this.buildLights();
    this.buildAtmosphere();
    this.buildDetailSet();
    this.buildLabels();
    this.buildPlaceholders();

    this.raycaster = new THREE.Raycaster();
    this.bindInput();
    this.resize();
    this.applyHomeCamera();
    const warm = this.warmScene().catch(error => console.warn('[VÉLANCE] pipeline warm-up failed:', error));
    if (this.preloadEntrance) this.prepareEntrance();
    else this.prioritize(this.focus);
    await warm;
    if (this.disposed) return;
    this.refreshShadow();
    this.frame = this.frame.bind(this);
    this.renderer.setAnimationLoop(this.frame);
  }

  /* ---------------------------------------------------------- architecture */
  buildArchitecture() {
    const S = this.hallArchitecture = new THREE.Group();
    this.scene.add(S);
    const marbleFloor = marbleTexture('#171c21', 'rgba(210,220,230,.5)', [10, 3]);
    this.marbleFloor = marbleFloor; // Also used by a TSL node, not always material.map.
    const marbleWall = marbleTexture('#1b2126', 'rgba(214,224,234,.55)', [1.6, 1]);
    const bronze = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: .42, metalness: .85 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: .5, metalness: .6 });
    const led = new THREE.MeshStandardMaterial({ color: 0x1a1208, emissive: 0xffc287, emissiveIntensity: 2.6, roughness: .4 });

    // Polished floor: a real planar reflection under a marble veil, mixed in
    // display space exactly as the WebGL build layered them, in one opaque draw.
    let floorMat;
    if (!this.memoryConstrained) {
      this.refl = reflector({ resolutionScale: .5, samples: this.backend === 'webgpu' ? 2 : 0, bounces: false });
      this.refl.target.rotation.x = -Math.PI / 2;
      S.add(this.refl.target);
      this.uReflect = uniform(1);
      this.uVeil = uniform(.78);
      const mirror = toDisplay(blendOverlay(this.refl.rgb, tslColor(0x777c82))).mul(this.uReflect);
      const marble = toDisplay(texture(marbleFloor).rgb);
      floorMat = new THREE.MeshBasicNodeMaterial();
      floorMat.colorNode = fromDisplay(mix(mirror, marble, this.uVeil));
      this.patchReflector();
    } else {
      floorMat = new THREE.MeshStandardMaterial({ map: marbleFloor, roughness: .16, metalness: .35, color: 0x9aa2a8 });
    }
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(HALL_W, HALL_DEPTH), floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    S.add(this.floor);
    this.buildOverviewApron();

    const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(HALL_W, HALL_DEPTH), floorDecal(new THREE.ShadowMaterial({ opacity: SHADOW_OPACITY })));
    shadowCatcher.rotation.x = -Math.PI / 2; shadowCatcher.position.set(0, .004, 0);
    shadowCatcher.receiveShadow = true; shadowCatcher.renderOrder = 2;
    S.add(shadowCatcher);

    // Two facing walls of the rectangle: one marble panel per bay + wall-wash.
    // The south group hides in overview so the aerial camera sees the rear row.
    this.washes = []; this.bayFixtures = []; this.bayLowFixtures = [];
    this.southGroup = new THREE.Group();
    this.northGroup = new THREE.Group();
    S.add(this.southGroup, this.northGroup);
    const washTex = washTexture();
    const fixtureGeo = new THREE.BoxGeometry(2.65, .075, .12);
    for (let i = 0; i < this.bayCount; i++) {
      const rear = i >= 8;
      const wz = rear ? -WALL_Z : WALL_Z;
      const inward = rear ? -1 : 1;
      const parent = rear ? this.southGroup : this.northGroup;
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(BAY_W - .5, 4.5), new THREE.MeshStandardMaterial({ map: marbleWall, roughness: .34, metalness: .12, color: 0xb9c2c9 }));
      panel.position.set(bayX(i), 2.45, wz + inward * .02);
      if (rear) panel.rotation.y = Math.PI;
      parent.add(panel);
      const wash = new THREE.Mesh(new THREE.PlaneGeometry(BAY_W - .8, 4.3), floorDecal(new THREE.MeshBasicMaterial({ map: washTex, opacity: .5 * K_ADD, blending: THREE.AdditiveBlending })));
      wash.position.set(bayX(i), 2.5, wz + inward * .06);
      if (rear) wash.rotation.y = Math.PI;
      wash.renderOrder = 3;
      parent.add(wash); this.washes.push(wash);
      const sconce = new THREE.Mesh(new THREE.CylinderGeometry(.07, .09, .22, 12), darkMetal);
      sconce.position.set(bayX(i), 4.62, wz + inward * .22); sconce.rotation.x = inward * .5;
      parent.add(sconce);
      // Each bay has its own emissive practical fixture. The light sequence
      // changes material intensity, avoiding sixteen extra real-time lights.
      const fixture = new THREE.Mesh(
        fixtureGeo,
        new THREE.MeshStandardMaterial({ color: 0x35281a, emissive: 0xffd7a2, emissiveIntensity: .05, roughness: .32 })
      );
      fixture.position.set(bayX(i), 4.57, wz + inward * .3);
      parent.add(fixture); this.bayFixtures.push(fixture);
      // The cutaway exposes a real floor-level practical instead of leaving
      // the upper fixture floating when its supporting wall is hidden.
      const lowFixture=new THREE.Mesh(new THREE.BoxGeometry(1.85,.032,.10),fixture.material);
      lowFixture.position.set(bayX(i),.13,wz+inward*.48);lowFixture.visible=false;
      S.add(lowFixture);this.bayLowFixtures.push(lowFixture);
    }
    for (const rear of [false, true]) {
      const wz = rear ? -WALL_Z : WALL_Z;
      const inward = rear ? -1 : 1;
      const parent = rear ? this.southGroup : this.northGroup;
      const wallBase = new THREE.Mesh(new THREE.BoxGeometry(HALL_W, .22, .3), bronze);
      wallBase.position.set(0, .11, wz + inward * .12); parent.add(wallBase);
      const wallHead = new THREE.Mesh(new THREE.BoxGeometry(HALL_W, .5, .34), darkMetal);
      wallHead.position.set(0, 4.95, wz + inward * .14); parent.add(wallHead);
      const wallStrip = new THREE.Mesh(new THREE.BoxGeometry(HALL_W, .035, .05), led);
      wallStrip.position.set(0, 4.68, wz + inward * .3); parent.add(wallStrip);
      for (let k = 0; k <= 8; k++) {
        const x = bayX(0) - BAY_W / 2 + k * BAY_W;
        const col = new THREE.Mesh(new THREE.BoxGeometry(.5, CEIL_Y, .62), bronze);
        col.position.set(x, CEIL_Y / 2, wz + inward * .34); parent.add(col);
        const strip = new THREE.Mesh(new THREE.BoxGeometry(.055, 4.5, .03), led);
        strip.position.set(x, 2.45, wz + inward * .67); parent.add(strip);
      }
    }

    // Side walls close the rectangle; the brand sign lives on the west wall.
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x10151a, roughness: .6, metalness: .3 });
    this.sideGroups = new Map();
    for (const sx of [-1, 1]) {
      const side = new THREE.Group(); this.sideGroups.set(sx, side); S.add(side);
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(HALL_DEPTH - .8, CEIL_Y), sideMat);
      wall.rotation.y = sx * -Math.PI / 2; wall.position.set(sx * HALL_W / 2, CEIL_Y / 2, 0);
      side.add(wall);
      for (let k = 0; k < 4; k++) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(.03, 4.4, .05), led);
        strip.position.set(sx * (HALL_W / 2 - .05), 2.4, -5.6 + k * 4.2);
        side.add(strip);
      }
    }
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.2), new THREE.MeshBasicMaterial({ map: textTexture('VÉLANCE', { size: 512, font: '500 92px Georgia, serif', metallic: true }), transparent: true, depthWrite: false }));
    sign.rotation.y = Math.PI / 2; sign.position.set(-HALL_W / 2 + .06, 2.6, 0); this.sideGroups.get(-1).add(sign);

    // Slatted ceiling + LED coves (one group, lifted away in overview).
    this.ceilGroup = new THREE.Group();
    S.add(this.ceilGroup);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(HALL_W, HALL_DEPTH), new THREE.MeshStandardMaterial({ color: 0x0c0f12, roughness: .8 }));
    ceil.rotation.x = Math.PI / 2; ceil.position.set(0, CEIL_Y, 0); this.ceilGroup.add(ceil);
    const slatGeo = new THREE.BoxGeometry(.07, .14, HALL_DEPTH - .4);
    const slatCount = Math.floor(HALL_W / .42);
    const slats = new THREE.InstancedMesh(slatGeo, bronze, slatCount);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < slatCount; i++) { m4.setPosition(-HALL_W / 2 + .21 + i * .42, CEIL_Y - .08, 0); slats.setMatrixAt(i, m4); }
    this.ceilGroup.add(slats);
    for (const z of [-2.9, 2.9]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(HALL_W - 1, .04, .09), led);
      strip.position.set(0, CEIL_Y - .17, z); this.ceilGroup.add(strip);
    }
    const ring = roundedRing(20.5, 7.4, 1.5, .1);
    const ringMesh = new THREE.Mesh(ring, led);
    ringMesh.rotation.x = Math.PI / 2; ringMesh.position.set(0, CEIL_Y - .16, 0);
    this.ceilGroup.add(ringMesh);

    // Each bay is a physical architectural cell, open toward the centre
    // aisle. Shared low partitions align with the existing rear wall piers.
    // They never enter a car's footprint or obstruct the aerial view.
    this.bayArchitecture = new THREE.Group(); S.add(this.bayArchitecture);
    const dividerMat = new THREE.MeshStandardMaterial({color:0x293139,roughness:.62,metalness:.22,emissive:0x151a1e,emissiveIntensity:.35});
    const dividerCap = new THREE.MeshStandardMaterial({color:0x615340,roughness:.46,metalness:.54});
    const partitionGeo = new THREE.BoxGeometry(.24,.78,2.65);
    const capGeo = new THREE.BoxGeometry(.27,.055,2.65);
    const sillGeo = new THREE.BoxGeometry(.24,.12,2.55);
    const cells = new THREE.InstancedMesh(partitionGeo,dividerMat,18);
    const caps = new THREE.InstancedMesh(capGeo,dividerCap,18);
    const sills = new THREE.InstancedMesh(sillGeo,dividerMat,18);
    for(let r=0;r<2;r++) for(let j=0;j<=8;j++){
      const i=r*9+j,x=bayX(0)-BAY_W/2+j*BAY_W,sign=r===0?-1:1;
      m4.makeTranslation(x,.39,sign*6.48);cells.setMatrixAt(i,m4);
      m4.makeTranslation(x,.807,sign*6.48);caps.setMatrixAt(i,m4);
      m4.makeTranslation(x,.06,sign*3.88);sills.setMatrixAt(i,m4);
    }
    this.bayArchitecture.add(cells,caps,sills);
    // Wheel stops, floor numbers, contact shadows, and light pools.
    const poolTex = radialTexture('rgba(255,205,150,.5)', 'rgba(255,190,120,0)');
    // Darkening also happens before tone mapping now: lift the alpha curve.
    const contactTex = radialTexture('rgba(0,0,0,.5)', 'rgba(0,0,0,0)', a => 1 - Math.pow(1 - a, 2.2));
    this.pools = []; this.contacts = [];
    for (let i = 0; i < this.bayCount; i++) {
      const rear = i >= 8;
      const cz = carZ(i);
      const inward = rear ? -1 : 1;
      const wz = rear ? -WALL_Z : WALL_Z;
      const stop = new THREE.Mesh(new THREE.BoxGeometry(2.1, .11, .26), darkMetal);
      stop.position.set(bayX(i), .055, wz + inward * .48); S.add(stop);
      const num = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.15), floorDecal(new THREE.MeshBasicMaterial({ map: textTexture(String(i + 1).padStart(2, '0'), { font: '500 118px Georgia, serif', color: 'rgba(226,205,170,.6)' }), opacity: K_LINE })));
      num.rotation.x = -Math.PI / 2; if (rear) num.rotation.z = Math.PI;
      num.position.set(bayX(i), .007, cz + inward * 3.4); num.renderOrder = 4; S.add(num);
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(BAY_W - .6, 7.4), floorDecal(new THREE.MeshBasicMaterial({ map: poolTex, opacity: .34 * K_ADD, blending: THREE.AdditiveBlending })));
      pool.rotation.x = -Math.PI / 2; pool.position.set(bayX(i), .005, cz + inward * .25); pool.renderOrder = 3;
      S.add(pool); this.pools.push(pool);
      const contact = new THREE.Mesh(new THREE.PlaneGeometry(5.1, 2.7), floorDecal(new THREE.MeshBasicMaterial({ map: contactTex })));
      contact.rotation.x = -Math.PI / 2; contact.position.set(bayX(i), .009, cz); contact.renderOrder = 5;
      contact.visible = false;
      S.add(contact); this.contacts.push(contact);
    }
  }
  buildOverviewApron() {
    const group = this.overviewApron = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ map: marbleTexture('#20262b','rgba(158,168,178,.22)',[26,22]), color: 0x8d969d, roughness: .88 });
    const basalt = new THREE.MeshStandardMaterial({ color: 0x20272d, metalness: .12, roughness: .72 });
    const bevel = new THREE.MeshStandardMaterial({ color: 0x555450, metalness: .52, roughness: .43 });
    const reveal = new THREE.MeshBasicMaterial({ color: 0x080a0c });
    const cove = new THREE.MeshBasicMaterial({ color: 0xa58b67, toneMapped: false });
    const base = new THREE.Mesh(new THREE.PlaneGeometry(94, 72), stone);
    base.rotation.x = -Math.PI / 2; base.position.y = -.92; group.add(base);
    const box = (w,h,d,x,y,z,material) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material); m.position.set(x,y,z); group.add(m); return m; };
    // One continuous museum plinth. The recessed illuminated fascia explains
    // the change of floor level; no extra parking bays or decorative grid.
    box(HALL_W + 3.4,.30,HALL_DEPTH + 3.4,0,-.76,0,basalt);
    box(HALL_W + 2.5,.12,HALL_DEPTH + 2.5,0,-.53,0,bevel);
    box(HALL_W + 1.16,.16,HALL_DEPTH + 1.16,0,-.39,0,reveal);
    box(HALL_W + 1.8,.07,HALL_DEPTH + 1.8,0,-.30,0,cove);
    box(HALL_W + 1.9,.25,HALL_DEPTH + 1.9,0,-.135,0,basalt);
    // Soft contact light under the island, baked into a floor decal instead
    // of adding moving spotlights or bright lines across the foreground.
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(HALL_W+18,HALL_DEPTH+16),new THREE.MeshBasicMaterial({map:radialTexture('rgba(194,154,102,.16)','rgba(194,154,102,0)'),transparent:true,depthWrite:false,opacity:.66}));
    pool.rotation.x=-Math.PI/2;pool.position.y=-.91;group.add(pool);
    this.buildOverviewGallery(group);
    group.visible=false; this.scene.add(group);
  }
  buildOverviewGallery(parent) {
    // An enclosed exhibition atrium around the sixteen-bay island. Unlike
    // the old north-only facade, both the room shell and the inner arcade
    // continue around every side. The aerial crane is inside the atrium.
    const g = this.overviewGallery = new THREE.Group();
    parent.add(g);
    const stone = new THREE.MeshStandardMaterial({color:0x343b40,emissive:0x171c20,emissiveIntensity:.65,roughness:.78,metalness:.12});
    const dark = new THREE.MeshStandardMaterial({color:0x20272c,emissive:0x161c21,emissiveIntensity:.50,roughness:.72});
    const bronze = new THREE.MeshStandardMaterial({color:0x554c40,emissive:0x2a241b,emissiveIntensity:.32,metalness:.55,roughness:.46});
    const light = new THREE.MeshBasicMaterial({color:0xbda482,toneMapped:false});
    const recessMap = canvasTexture(512,(ctx,s)=>{
      ctx.fillStyle='#20272c';ctx.fillRect(0,0,s,s);
      const wash=ctx.createRadialGradient(s*.5,s*.08,0,s*.5,s*.25,s*.8);
      wash.addColorStop(0,'rgba(220,194,151,.65)');wash.addColorStop(.42,'rgba(160,135,101,.22)');wash.addColorStop(1,'rgba(160,135,101,0)');
      ctx.fillStyle=wash;ctx.fillRect(0,0,s,s);
      ctx.fillStyle='rgba(200,205,210,.055)';
      for(let i=1;i<5;i++)ctx.fillRect(0,i*s/5,s,1);
    });
    const recess = new THREE.MeshBasicMaterial({map:recessMap,toneMapped:false});
    // Reuse a unit box/plane and instance each material. Four-sided detail
    // stays cheap instead of multiplying small draw calls for each bay.
    const buckets=new Map(), unitBox=new THREE.BoxGeometry(1,1,1),unitPlane=new THREE.PlaneGeometry(1,1);
    const pos=new THREE.Vector3(),scale=new THREE.Vector3(),q=new THREE.Quaternion(),axis=new THREE.Vector3(0,1,0);
    const add=(root,mat,w,h,d,x,y,z,plane=false)=>{
      const a=root.yaw,c=Math.cos(a),s=Math.sin(a);
      pos.set(root.x+c*x+s*z,y,root.z-s*x+c*z);scale.set(w,h,d);q.setFromAxisAngle(axis,a);
      const key=mat.uuid+(plane?'p':'b');if(!buckets.has(key))buckets.set(key,{mat,geo:plane?unitPlane:unitBox,matrices:[]});
      buckets.get(key).matrices.push(new THREE.Matrix4().compose(pos,q,scale));
    };
    const shell=(x,z,yaw,width,count)=>{
      const root={x,z,yaw},b=(w,h,d,lx,y,lz,m)=>add(root,m,w,h,d,lx,y,lz);
      const height=58, moduleW=width/count;
      b(width,height,.50,0,height/2-.9,-.25,dark);
      // A tall, continuous interior wall with structural pilasters and
      // horizontal galleries; its top is above the highest aerial camera.
      for(const y of [7.4,15.8,29.2,43.0,56.5]){
        b(width,.38,.80,0,y,.20,stone);b(width,.055,.06,0,y-.24,.62,bronze);
      }
      for(let i=0;i<=count;i++) b(.42,height,.7,(i-count/2)*moduleW,height/2-.9,.12,stone);
      for(let i=0;i<count;i++){
        const lx=(i-(count-1)/2)*moduleW;
        add(root,recess,moduleW-.65,6.6,1,lx,3.25,.055,true);
        b(moduleW-.78,.08,.12,lx,6.7,.30,light);
      }
    };
    this.exhibitionBounds={halfX:46,halfZ:35,floor:-.92,ceiling:57.1};
    shell(0,-35,0,92,12);shell(0,35,Math.PI,92,12);
    shell(-46,0,Math.PI/2,70,10);shell(46,0,-Math.PI/2,70,10);
    add({x:0,z:0,yaw:0},dark,92,.4,70,0,57.3,0);
    // Inner arcade connected at the corners. The opening above the parking
    // island is intentional: the camera can descend without hiding its roof.
    const arcade=(x,z,yaw,width,count)=>{
      const root={x,z,yaw},b=(w,h,d,lx,y,lz,m)=>add(root,m,w,h,d,lx,y,lz);
      const moduleW=width/count;
      b(width,.28,5.4,0,-.75,.5,stone); // continuous promenade
      b(width,4.8,.42,0,2.25,-1.3,dark);
      b(width,.34,3.1,0,5.00,.05,stone); // deep canopy
      b(width,.09,3.15,0,5.22,.05,dark);
      b(width,.055,.075,0,4.80,1.58,light);
      b(width,.30,.55,0,.0,-1.0,stone);
      for(let i=0;i<count;i++){
        const lx=(i-(count-1)/2)*moduleW;
        add(root,recess,moduleW-.77,4.12,1,lx,2.21,-1.065,true);
        b(moduleW-.80,.18,.70,lx,4.48,-.70,stone);
        b(moduleW-1.0,.065,.10,lx,4.34,-.31,light);
      }
      for(let i=0;i<=count;i++){
        const lx=(i-count/2)*moduleW;
        b(.44,4.77,1.20,lx,2.38,.75,stone);
        b(.07,4.10,.07,lx,2.4,1.37,bronze);
      }
    };
    arcade(0,-17.9,0,70.6,10);arcade(0,17.9,Math.PI,70.6,10);
    arcade(-35.3,0,Math.PI/2,35.8,5);arcade(35.3,0,-Math.PI/2,35.8,5);
    for(const {mat,geo,matrices} of buckets.values()){
      const mesh=new THREE.InstancedMesh(geo,mat,matrices.length);
      matrices.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.computeBoundingSphere();g.add(mesh);
    }
    g.userData.sides=4;
  }
  buildStudio() {
    // The detail room is a separate architectural set, sharing the renderer
    // and original GLB. Its walls are outside every allowed orbit radius.
    const g = this.studioGroup = new THREE.Group();
    this.studioRadius = 13.2;
    const wall = new THREE.MeshStandardMaterial({ color:0x22292d, emissive:0x151a1d, emissiveIntensity:.6, roughness:.86, metalness:.17, side:THREE.BackSide });
    const floor = new THREE.MeshStandardMaterial({ map:marbleTexture('#1c2228','rgba(180,180,170,.25)',[5,5]), color:0x657078, roughness:.66, metalness:.22 });
    const trim = new THREE.MeshStandardMaterial({color:0x51483b,emissive:0x271d13,emissiveIntensity:.38,roughness:.43,metalness:.55});
    const light = new THREE.MeshBasicMaterial({color:0xcdb38b});
    const frame = new THREE.MeshStandardMaterial({color:0x252c32,emissive:0x14191d,emissiveIntensity:.48,roughness:.62,metalness:.25});
    const dark = new THREE.MeshStandardMaterial({color:0x151b20,roughness:.8,metalness:.12});
    // Textured, indirectly lit architectural panels. A baked wash provides
    // stable photographic-looking illumination at every orbit angle without
    // increasing the number of scene lights or tracking the camera.
    const panelTex = canvasTexture(512,(ctx,s)=>{
      ctx.fillStyle='#30363a';ctx.fillRect(0,0,s,s);
      let seed=193;const rnd=()=>((seed=seed*16807%2147483647)/2147483647);
      for(let i=0;i<16000;i++){
        const x=rnd()*s,y=rnd()*s;ctx.fillStyle=i%2?'rgba(205,207,198,.025)':'rgba(0,0,0,.035)';ctx.fillRect(x,y,1+rnd()*2,1+rnd()*2);
      }
      for(let i=0;i<26;i++){
        ctx.strokeStyle='rgba(185,181,168,.045)';ctx.lineWidth=.5+rnd()*1.2;ctx.beginPath();let x=rnd()*s,y=rnd()*s;ctx.moveTo(x,y);
        for(let j=0;j<5;j++){x+=(rnd()-.5)*s*.35;y+=(rnd()-.4)*s*.27;ctx.lineTo(x,y);}ctx.stroke();
      }
      const wash=ctx.createRadialGradient(s*.5,s*.05,0,s*.5,s*.25,s*.84);wash.addColorStop(0,'rgba(218,187,144,.68)');wash.addColorStop(.32,'rgba(165,137,106,.40)');wash.addColorStop(1,'rgba(165,137,106,0)');ctx.fillStyle=wash;ctx.fillRect(0,0,s,s);
      const low=ctx.createLinearGradient(0,s*.68,0,s);low.addColorStop(0,'rgba(0,0,0,0)');low.addColorStop(1,'rgba(0,0,0,.38)');ctx.fillStyle=low;ctx.fillRect(0,0,s,s);
    });
    const panel = new THREE.MeshBasicMaterial({map:panelTex,toneMapped:false});
    const finMat = new THREE.MeshStandardMaterial({color:0x414344,emissive:0x211d17,emissiveIntensity:.36,roughness:.44,metalness:.65});
    const finEdge = new THREE.MeshBasicMaterial({color:0x86745a,toneMapped:false});
    const room = new THREE.Mesh(new THREE.CylinderGeometry(this.studioRadius,this.studioRadius,7.6,64,1,true),wall); room.position.y=3.8; g.add(room);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(this.studioRadius,64),floor); ground.rotation.x=-Math.PI/2; ground.position.y=-.14;g.add(ground);
    const podium = new THREE.Mesh(new THREE.CylinderGeometry(3.35,3.48,.14,96),floor);podium.position.y=-.07;g.add(podium);
    const podiumEdge = new THREE.Mesh(new THREE.TorusGeometry(3.42,.022,6,96),trim);podiumEdge.rotation.x=Math.PI/2;podiumEdge.position.y=-.055;g.add(podiumEdge);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(3.34,64),floorDecal(new THREE.ShadowMaterial({opacity:.42}))); shadow.rotation.x=-Math.PI/2;shadow.position.y=.004;shadow.receiveShadow=true; shadow.renderOrder=2;g.add(shadow);
    const contact = new THREE.Mesh(new THREE.PlaneGeometry(5.8,5.8),floorDecal(new THREE.MeshBasicMaterial({map:radialTexture('rgba(0,0,0,.65)','rgba(0,0,0,0)')}))); contact.rotation.x=-Math.PI/2;contact.position.y=.009;g.add(contact);
    // Twelve fixed architectural recesses with depth, thick pilasters, dark
    // fluted sides and concealed overhead light. There are no moving props.
    const slots=12, moduleW=5.9, radius=12.42;
    const place=(mesh,a,x,y,z)=>{mesh.position.set(Math.cos(a)*x+Math.sin(a)*z,y,-Math.sin(a)*x+Math.cos(a)*z);mesh.rotation.y=a;g.add(mesh);};
    const box=(w,h,d,mat,a,x,y,z)=>place(new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat),a,x,y,z);
    for(let i=0;i<slots;i++){
      const a=i*Math.PI*2/slots;
      box(moduleW,6.65,.22,frame,a,0,3.37,radius+.14);
      const inset = new THREE.Mesh(new THREE.PlaneGeometry(4.72,5.17),panel);
      place(inset,a,0,3.47,radius-.005);inset.rotation.y+=Math.PI;
      for(const side of [-1,1]){
        box(.31,6.78,.56,trim,a,side*2.69,3.39,radius-.16);
        for(let j=0;j<3;j++) box(.065,5.25,.10,dark,a,side*(2.24+j*.13),3.45,radius-.20);
      }
      box(5.10,.35,.54,frame,a,0,6.29,radius-.14);
      box(4.55,.065,.10,light,a,0,6.07,radius-.43);
      box(5.10,.22,.37,dark,a,0,.78,radius-.10);
      // Alternate stone display bays with sculpted, brushed-metal fins. Their
      // differing depths give the orbit genuine parallax instead of a flat
      // repeating cylinder; leave the fixed brand panel unobstructed.
      if(i%3===1){
        for(let j=0;j<9;j++){
          const depth=.17+.22*Math.sin(Math.PI*j/8);
          box(.28,4.80,depth,finMat,a,(j-4)*.49,3.33,radius-.08-depth/2);
          box(.024,4.80,.024,finEdge,a,(j-4)*.49-.13,3.33,radius-.095-depth);
        }
      }
    }
    // Architectural soffit and base molding stay outside camera clearance.
    for(const y of [.24,6.72]){
      const ring=new THREE.Mesh(new THREE.TorusGeometry(12.48,.11,6,96),trim);ring.rotation.x=Math.PI/2;ring.position.y=y;g.add(ring);
    }
    // Single fixed wall-mounted mark, readable only from its front face.
    this.studioMark=new THREE.Mesh(new THREE.PlaneGeometry(5.6,1.1),new THREE.MeshBasicMaterial({map:textTexture('VÉLANCE',{size:512,font:'500 92px Georgia, serif',metallic:true}),transparent:true,depthWrite:false}));
    this.studioMark.position.set(0,3.65,-radius+.045);this.studioMark.scale.setScalar(.74);g.add(this.studioMark);
    g.visible=false;this.scene.add(g);
  }
  // Nested reflection renders during compilation would force synchronous builds.
  patchReflector() {
    const base = this.refl.reflector;
    const update = base.updateBefore.bind(base);
    base.updateBefore = frame => {
      if (this.renderer._precompilationState) return false;
      if (!this.reflectOn) { this.reflectorDraws = 0; return; }
      // A static viewpoint reuses the previous mirror pass at half rate; any
      // camera move, fade or flight refreshes it every frame at full quality.
      // WebGL2 compiles mirror variants lazily per program, so there the pass
      // must keep running every frame to spread those builds across parks.
      if (this.backend !== 'webgpu') {
        const before0 = this.renderer.info.render.drawCalls;
        const result0 = update(frame);
        this.reflectorDraws = this.renderer.info.render.drawCalls - before0;
        return result0;
      }
      const c = this.camera, sig = this.reflCam;
      const moved = !sig || this.reflDirty || !!this.flight || this.fades.size > 0 ||
        Math.abs(c.position.x - sig[0]) + Math.abs(c.position.y - sig[1]) + Math.abs(c.position.z - sig[2]) > 1e-4 ||
        Math.abs(c.quaternion.x - sig[3]) + Math.abs(c.quaternion.y - sig[4]) + Math.abs(c.quaternion.z - sig[5]) + Math.abs(c.quaternion.w - sig[6]) > 1e-5;
      if (moved) {
        this.reflSkip = false; this.reflDirty = false;
        this.reflCam = [c.position.x, c.position.y, c.position.z, c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w];
      } else if ((this.reflSkip = !this.reflSkip)) { this.reflectorDraws = 0; return; }
      const before = this.renderer.info.render.drawCalls;
      const result = update(frame);
      this.reflectorDraws = this.renderer.info.render.drawCalls - before;
      return result;
    };
  }

  // Light visibility changes rebuild lit pipelines; switch intensities instead.
  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xf3e6d0, 0x343538, .5));
    this.spots = [];
    // Mobile fragments pay for every light in the scene: four travelling spots
    // cover the visible neighbourhood instead of eight fixed ones.
    const spotCount = this.mobile ? 4 : this.perRow;
    for (let k = 0; k < spotCount; k++) {
      const spot = new THREE.SpotLight(0xffd9a6, 110, 0, .66, .55, 1.8);
      spot.userData.gp = new THREE.Vector3(); spot.userData.gt = new THREE.Vector3();
      this.scene.add(spot, spot.target);
      this.spots.push(spot);
    }
    this.spotRow = -1;
    this.layoutSpots(this.row);
    this.keyShadow = new THREE.SpotLight(0xffe2b8, 0, 0, .6, .5, 1.8);
    this.keyShadow.castShadow = true;
    const shadow = this.keyShadow.shadow;
    shadow.mapSize.set(this.mobile ? 512 : 1024, this.mobile ? 512 : 1024);
    shadow.bias = -.0004;
    shadow.radius = 3;
    shadow.camera.near = 1; shadow.camera.far = 14;
    shadow.autoUpdate = false;
    this.scene.add(this.keyShadow, this.keyShadow.target);
    const fill = new THREE.DirectionalLight(0xd6d5d0, .35);
    fill.position.set(4, 6, 8); this.scene.add(fill);
    // Overview trades the bay spots for two directionals: the aerial map view
    // stays cheap enough to pan at full frame rate.
    const oKey = new THREE.DirectionalLight(0xffe0b0, 0); oKey.position.set(6, 14, 8); oKey.userData.on = 2.4;
    const oFill = new THREE.DirectionalLight(0xd6d5d0, 0); oFill.position.set(-8, 10, -6); oFill.userData.on = .9;
    this.overviewLights = [oKey, oFill];
    this.scene.add(oKey, oFill);
  }
  // Eight spotlights are reused for whichever row is on screen, keeping the
  // per-fragment light count constant now that both rows hold machines.
  // Mobile keeps four and slides them with the focus (eased in the loop).
  layoutSpots(row) {
    const lo = row * this.perRow, hi = lo + this.perRow - 1;
    const center = this.mobile ? clamp(this.focus, lo, hi) : -1;
    if (this.spotRow === row && this.spotCenter === center) return;
    this.spotRow = row; this.spotCenter = center;
    const inward = row === 0 ? 1 : -1;
    for (let k = 0; k < this.spots.length; k++) {
      const i = this.mobile ? clamp(center - 1 + k, lo, hi) : lo + k;
      const spot = this.spots[k];
      const first = spot.userData.bay === undefined;
      spot.userData.bay = i;
      spot.userData.gp.set(bayX(i), CEIL_Y - .25, carZ(i) + inward * 1.45);
      spot.userData.gt.set(bayX(i), 0, carZ(i));
      if (first) { spot.position.copy(spot.userData.gp); spot.target.position.copy(spot.userData.gt); }
    }
  }
  rowBounds(row = this.row) { const lo = row * this.perRow; return [lo, lo + this.perRow - 1]; }
  refreshShadow() { this.keyShadow.shadow.needsUpdate = true; this.reflDirty = true; }

  /* Drifting ground smoke + volumetric light shafts + dust in the beam. */
  buildAtmosphere() {
    const S = this.scene;
    this.smoke = [];
    const smokeTex = smokeTexture();
    const count = this.mobile ? 4 : 10;
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, color: 0xcfd4da, opacity: (.1 + (i % 4) * .03) * K_SMOKE });
      mat.rotation = (i * .7) % 6.28;
      const sp = new THREE.Sprite(mat);
      const x = -HALL_W / 2 + 4 + i * (HALL_W - 8) / Math.max(1, count - 1);
      sp.position.set(x, .7 + (i % 3) * .5, (i % 2 ? -2.2 : 2.2));
      const sc = 7 + (i % 3) * 3;
      sp.scale.set(sc, sc * .55, 1);
      sp.userData = { x, phase: i * 1.3, speed: .12 + (i % 5) * .03, base: mat.opacity };
      S.add(sp); this.smoke.push(sp);
    }
    this.shafts = [];
    const shaftTex = shaftTexture();
    const shaftGeo = new THREE.CylinderGeometry(.35, 2.3, CEIL_Y - .4, 12, 1, true);
    for (let i = 0; i < this.homeCount; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: shaftTex, transparent: true, opacity: .16 * K_ADD, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const cone = new THREE.Mesh(shaftGeo, mat);
      cone.position.set(bayX(i), (CEIL_Y - .4) / 2 + .1, carZ(i));
      cone.renderOrder = 6;
      S.add(cone); this.shafts.push(cone);
    }
    // Dust motes: one instanced draw of soft round sprites, animated on the GPU
    // (WebGPU point primitives are fixed at one pixel).
    const N = this.mobile ? 48 : 140;
    const seeds = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) seeds.set([(Math.random() - .5) * 3, Math.random() * 4, (Math.random() - .5) * 3, i], i * 4);
    const seed = instancedBufferAttribute(new THREE.InstancedBufferAttribute(seeds, 4));
    this.uMoteTime = uniform(0);
    const t = this.uMoteTime;
    const mat = new THREE.PointsNodeMaterial({ color: 0xffe0b0, size: .035, transparent: true, opacity: .5 * K_ADD, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    mat.positionNode = vec3(seed.x.sub(t.mul(.6).add(seed.w).cos().mul(.05 / .6)), seed.y.add(t.mul(.12)).mod(4.2), seed.z);
    mat.opacityNode = materialOpacity.mul(smoothstep(.15, .5, uv().sub(.5).length()).oneMinus());
    this.motes = new THREE.Sprite(mat);
    this.motes.count = N;
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 7;
    S.add(this.motes);

    // Overview dressing: a champagne light band sweeps the polished floor and a
    // hover ring answers the pointer, so the aerial map reads alive, not static.
    const sweepTex = canvasTexture(128, (ctx, s) => {
      const g = ctx.createLinearGradient(0, 0, s, 0);
      g.addColorStop(0, 'rgba(240,220,180,0)');
      g.addColorStop(.5, 'rgba(240,220,180,.55)');
      g.addColorStop(1, 'rgba(240,220,180,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    });
    this.ovSweep = new THREE.Mesh(new THREE.PlaneGeometry(7, HALL_DEPTH), new THREE.MeshBasicMaterial({ map: sweepTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.ovSweep.rotation.x = -Math.PI / 2; this.ovSweep.position.y = .012; this.ovSweep.renderOrder = 3;
    this.ovSweep.visible = false; S.add(this.ovSweep);
    this.ovHoverRing = new THREE.Mesh(new THREE.RingGeometry(2.5, 2.62, 64), new THREE.MeshBasicMaterial({ color: 0xe6cba0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.ovHoverRing.rotation.x = -Math.PI / 2; this.ovHoverRing.position.y = .02; this.ovHoverRing.renderOrder = 5;
    this.ovHoverRing.visible = false; S.add(this.ovHoverRing);
  }
  updateAtmosphere(now, dt) {
    const on = !this.overview || this.cinema;
    const t = now / 1000;
    for (const sp of this.smoke) {
      sp.visible = true;
      if (this.reduced) continue;
      const u = sp.userData;
      sp.position.x = u.x + Math.sin(t * u.speed + u.phase) * 1.6;
      sp.material.rotation += dt * .02;
      sp.material.opacity = u.base * (this.overview ? .55 : 1) * (1 + Math.sin(t * .3 + u.phase) * .3);
    }
    for (let i = 0; i < this.shafts.length; i++) {
      const cone = this.shafts[i];
      const focused = i === this.focus && this.mode === 'home' && !this.overview;
      const target = K_ADD * (this.cinema ? .34 * this.bayLightLevel(i) : !on ? 0 : this.mode === 'selected' ? (i === this.selected ? .22 : .05) : focused ? .26 : .1);
      cone.material.opacity += (target - cone.material.opacity) * Math.min(1, dt * 4);
      cone.visible = on && !(this.cinema && this.mobile) && cone.material.opacity > .01 * K_ADD;
    }
    this.motes.visible = on && !this.cinema && this.mode === 'home';
    this.motes.position.set(bayX(this.focus), 0, carZ(this.focus));
    if (!this.reduced && this.motes.visible) this.uMoteTime.value = t;
  }

  /* Selected-machine stage dressing: a champagne halo, brand wordmark on the
   * back wall and a lit pedestal ring so the detail view never feels bare. */
  buildDetailSet() {
    const g = new THREE.Group();
    const glowTex = canvasTexture(256, (ctx, s) => {
      const r = s / 2;
      const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
      grad.addColorStop(0, 'rgba(240,220,180,.55)');
      grad.addColorStop(.4, 'rgba(226,201,160,.18)');
      grad.addColorStop(1, 'rgba(226,201,160,0)');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, s, s);
    });
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .8 * K_ADD }));
    glow.scale.set(11, 8, 1); glow.position.set(0, .7, -2.5); g.add(glow);
    this.detailGlow = glow;
    const halo = new THREE.Mesh(new THREE.TorusGeometry(2.3, .035, 8, 72), new THREE.MeshBasicMaterial({ color: 0xe6cba0, transparent: true, opacity: .55 * K_ADD, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.position.set(0, .45, -2.4); g.add(halo);
    this.detailHalo = halo;
    const mark = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.1), new THREE.MeshBasicMaterial({ map: textTexture('VÉLANCE', { size: 512, font: '500 92px Georgia, serif', metallic: true }), transparent: true, depthWrite: false, opacity: .9, side: THREE.DoubleSide }));
    mark.position.set(0, 2.0, -1.9); g.add(mark);
    this.detailMark = mark;
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.3, 2.42, 72), new THREE.MeshBasicMaterial({ color: 0xe6cba0, transparent: true, opacity: .3 * K_ADD, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(0, .02, 0); g.add(ring);
    for (const sx of [-3.6, 3.6]) {
      const totem = new THREE.Mesh(new THREE.BoxGeometry(.05, 3.2, .05), new THREE.MeshBasicMaterial({ color: 0xf0dcb4, transparent: true, opacity: .5 * K_ADD, blending: THREE.AdditiveBlending, depthWrite: false }));
      totem.position.set(sx, 1.6, -2.3); g.add(totem);
    }
    for (const c of g.children) c.userData.bz = c.position.z;
    g.visible = false;
    this.detailSet = g;
    this.scene.add(g);
  }
  placeDetailSet(index) {
    if (!this.detailSet) return;
    this.detailSet.position.set(bayX(index), 0, carZ(index));
    this.detailSet.rotation.y = 0;
    // Counter orbit-yaw parallax per element so the halo rings the car and the
    // wordmark sits centred above it, clear of the wall pillars. Rear row mirrors
    // the dressing depth so it stays behind the machine from the rear camera.
    const sz = index < this.perRow ? 1 : -1;
    for (const c of this.detailSet.children) c.position.z = (c.userData.bz || 0) * sz;
    const t = Math.tan(this.heroYaw(index));
    if (this.detailHalo) this.detailHalo.position.x = -2.4 * t * sz;
    if (this.detailGlow) this.detailGlow.position.x = -2.5 * t * sz;
    if (this.detailMark) {
      this.detailMark.position.x = -1.9 * t * sz;
      // Face the wordmark at whichever side the camera enters from, so the
      // rear row and mobile see it centred above the machine too.
      this.detailMark.rotation.y = sz === 1 ? 0 : Math.PI;
      this.detailMark.scale.setScalar(this.mobile ? .8 : 1);
      this.detailMark.visible = true;
    }
    this.detailSet.visible = true;
  }

  /* ------------------------------------------------------------ pipelines */
  // Compilation runs share renderer state and must remain serialized.
  compile(root, prepare) {
    const run = async () => {
      if (this.disposed) return;
      const restore = prepare();
      let pending;
      try { pending = this.renderer.compileAsync(root, this.camera, this.scene); } finally { restore(); }
      await pending;
    };
    return (this.compileQueue = this.compileQueue.then(run, run));
  }
  warmScene() {
    return this.compile(this.scene, () => {
      const hidden = [this.detailSet, this.studioGroup, this.overviewApron, ...this.contacts].filter(o => !o.visible);
      for (const o of hidden) o.visible = true;
      const restoreCulling = cullOff(this.scene);
      return () => { for (const o of hidden) o.visible = false; restoreCulling(); };
    });
  }

  buildLabels() {
    this.labelHost.innerHTML = '';
    for (let i = 0; i < this.homeCount; i++) {
      const v = this.vehicles[i];
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'bay-label'; el.dataset.index = i;
      el.setAttribute('aria-label', `View bay ${i + 1}: ${v.make} ${v.name}`);
      el.innerHTML = `<span class="bay-label-no">BAY ${String(i + 1).padStart(2, '0')}</span><strong>${v.make} <em>${v.name}</em></strong><span class="bay-label-tag">${v.tag}</span><span class="bay-label-cta">VIEW THIS MACHINE ↗</span>`;
      this.inputLifetime.listen(el, 'click', () => {
        if (performance.now() < this.suppressUntil || this.dragged) return;
        if (this.mode !== 'home' || this.cinema || this.returning) return;
        this.onSelect(i);
      });
      this.labelHost.appendChild(el);
      this.labels.push(el);
    }
    // The portrait overview cannot fit sixteen model names next to the cars.
    // Keep numbered scene controls and provide a full collection picker that
    // reaches every vehicle, even while its model is still being prepared.
    const picker = document.createElement('div');
    picker.className = 'overview-picker'; picker.hidden = true;
    this.inputLifetime.listen(picker, 'keydown', e => { if (e.target.matches('select')) e.stopPropagation(); });
    const model = document.createElement('select');
    model.setAttribute('aria-label', 'Choose a vehicle from all sixteen bays');
    for (const [i, v] of this.vehicles.entries()) {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `${String(i + 1).padStart(2, '0')} · ${v.make} ${v.name}`;
      model.append(option);
    }
    model.value = String(this.focus);
    const view = document.createElement('button');
    view.type = 'button'; view.textContent = 'VIEW ↗';
    view.setAttribute('aria-label', 'View chosen vehicle');
    this.inputLifetime.listen(view, 'click', () => {
      if (this.mode === 'home' && this.overview && !this.cinema && !this.returning) this.onSelect(Number(model.value));
    });
    picker.append(model, view); this.stage.append(picker);
    this.overviewPicker = picker; this.overviewChoice = model;
  }

  /* ------------------------------------------------------------- loading */
  /* Only two compressed downloads are prefetched. Decode one GLB at a time;
     never keep an entire queue of parsed scenes/decoded textures. */
  async acquireDL() { while (this.dlActive >= this.dlLimit) await new Promise(r => this.dlWaiters.push(r)); this.dlActive++; }
  releaseDL() { this.dlActive--; (this.dlWaiters.shift() || (() => {}))(); }
  prefetch(index) {
    index %= this.vehicles.length;
    if (this.disposed || this.cars.has(index) || this.buffers.has(index)) return;
    const vehicle = this.vehicles[index];
    const controller = new AbortController(); this.dlControllers.add(controller);
    const task = (async () => {
      await this.acquireDL();
      try {
        const url = new URL(`./assets/models/gallery/${encodeURIComponent(vehicle.file)}`, location.href);
        const res = await fetch(url, { signal: controller.signal, cache: 'force-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.arrayBuffer();
      } finally { this.dlControllers.delete(controller); this.releaseDL(); }
    })();
    task.catch(() => {});
    this.buffers.set(index, task);
  }
  prefetchAhead(){for(const i of this.queue.slice(0,1))this.prefetch(i);}
  prioritize(index) {
    index %= this.vehicles.length;
    if (this.cars.has(index) || this.activeLoad === index || this.disposed) return;
    this.queue = this.queue.filter(i => i !== index);
    this.queue.unshift(index); this.queued.add(index);
    this.prefetch(index);
    this.runQueue();
  }
  sortQueue() { const col = this.focus % this.vehicles.length; this.queue.sort((a, b) => Math.abs(a - col) - Math.abs(b - col)); }
  enqueueAround(center) {
    center %= this.vehicles.length;
    // Explicit full-gallery gesture only. Never call this at initial boot.
    const order = loadOrder(center, this.vehicles.length, { all: true });
    for (const i of order) if (!this.cars.has(i) && i !== this.activeLoad && !this.queued.has(i)) { this.queue.push(i); this.queued.add(i); }
    this.runQueue();
  }
  prepareEntrance() {
    if (this.entrancePrepared || this.disposed) return;
    this.entrancePrepared = true;
    this.revealOrder = Array.from({ length: this.vehicles.length }, (_, i) => i).sort((a, b) => bayRevealOrder(a) - bayRevealOrder(b));
    this.queue = this.revealOrder.filter(i => !this.cars.has(i) && i !== this.activeLoad);
    this.queued = new Set(this.queue);
    this.runQueue();
  }
  runQueue() {
    if (this.loading || this.disposed) return this.queueTask;
    this.queueTask = this.drainQueue();
    return this.queueTask;
  }
  async drainQueue() {
    this.loading = true;
    try {
      while (this.queue.length) {
        if (this.disposed) return;
        const index = this.queue.shift(); this.queued.delete(index);
        if (this.cars.has(index)) continue;
        this.activeLoad = index;
        this.loadFailures.delete(index);
        this.labels[index].classList.remove('is-error');
        const vehicle = this.vehicles[index];
        const started = performance.now();
        let holder=null,rawScene=null;
        try {
          this.prefetch(index);
          this.prefetchAhead();
          const buffer = await this.buffers.get(index);
          this.buffers.delete(index);
          if (this.disposed) return;
          rawScene=(await this.loader.parseAsync(buffer,new URL('./assets/models/gallery/',location.href).href)).scene;
          if(this.disposed)return;
          holder=this.prepareModel(rawScene,index,'gallery');
          const casts = this.mode === 'selected' && index === this.selected;
          holder.traverse(n => { if (n.isMesh) n.castShadow = casts; });
          // Never compile a new machine mid-drag: the pipeline build would
          // hitch the very motion the visitor is steering.
          while (!this.disposed && this.drag?.moved) await new Promise(r => setTimeout(r, 80));
          if (this.disposed) return;
          await this.compile(holder, () => cullOff(holder));
          if (this.disposed) return;
          if (this.mode === 'selected' && index !== this.selected) { this.setCarAlpha(holder, 0); holder.visible = false; }
          holder.traverse(n => { if (n.isMesh) n.castShadow = this.mode === 'selected' && index === this.selected; });
          // Home culling never renders distant cars, so their textures would
          // all lazy-upload in one stall the first time overview reveals them.
          this.uploadModel(holder);
          if (this.cinema) holder.visible = false;
          this.scene.add(holder);
          this.cars.set(index, holder);
          this.installDetail();
          this.parked++;
          this.contacts[index].visible = true;
          const ph = this.placeholders.get(index);
          if (ph) ph.userData.dying = true;
          this.refreshShadow();
          this.loadTimes[vehicle.id] = Math.round(performance.now() - started);
          this.labels[index].classList.add('is-loaded');
          this.onProgress(this.parked, this.vehicles.length, index);
          if (!this.initialReady) { this.initialReady = true; this.onReady(); }
        } catch (err) {
          if (!this.disposed) { this.loadFailures.add(index); this.labels[index].classList.add('is-error'); this.onError(index, err.message || String(err)); }
        } finally {
          if(holder&&holder!==this.cars.get(index)&&holder!==this.detailResident?.gallery)disposeModel(holder);
          else if(!holder&&rawScene)disposeModel(rawScene);
          this.buffers.delete(index);
          this.activeLoad = null;
        }
      }
    } finally {
      this.loading = false;
      if (!this.disposed && this.queue.length) queueMicrotask(() => this.runQueue());
    }
  }
  prepareModel(scene,index,tier){
    const vehicle=this.vehicles[index],holder=normalise(scene,vehicle);
    holder.rotation.y+=.3+(index>=this.perRow?Math.PI:0)+(NOSE_BACK.has(vehicle.id)?Math.PI:0);
    holder.position.set(bayX(index),0,carZ(index));
    this.finishMaterials(holder);this.collectPaint(holder);
    this.applyPaint(holder,this.paintChoice.get(index));
    holder.userData.index=index;holder.userData.tier=tier;holder.userData.triangles=0;
    holder.traverse(n=>{if(n.isMesh)holder.userData.triangles+=(n.geometry.index?.count??n.geometry.attributes.position.count)/3;});
    return holder;
  }
  uploadModel(holder){for(const t of modelResources(holder).textures)if(!this.uploaded.has(t)){this.renderer.initTexture?.(t);this.uploaded.add(t);}}
  requestDetail(index){
    this.cancelDetail();const epoch=this.detailEpoch,controller=new AbortController();this.detailAbort=controller;
    const current=()=>!this.disposed&&epoch===this.detailEpoch&&this.mode==='selected'&&this.selected===index;
    // Wait for older canceled decodes to finish before starting another high
    // tier. Abort fetch immediately, release a late parse deterministically.
    const run=async()=>{
      if(!current())return;
      let raw=null,holder=null,retained=false;
      try{
        const url=new URL(`./assets/models/detail/${encodeURIComponent(this.vehicles[index].file)}`,location.href);
        const res=await fetch(url,{signal:controller.signal,cache:'force-cache'});
        if(!res.ok)throw new Error(`HTTP ${res.status}`);
        const buffer=await res.arrayBuffer();if(!current())return;
        raw=(await this.loader.parseAsync(buffer,new URL('./assets/models/detail/',location.href).href)).scene;
        if(!current())return;
        holder=this.prepareModel(raw,index,'detail');
        holder.traverse(n=>{if(n.isMesh)n.castShadow=true;});
        await this.compile(holder,()=>cullOff(holder));if(!current())return;
        this.uploadModel(holder);if(!current())return;
        this.pendingDetail={index,holder};retained=true;this.installDetail();
      }catch(error){if(current())this.onDetailError(index,error.message||String(error));}
      finally{if(!retained)disposeModel(holder||raw);if(this.detailAbort===controller)this.detailAbort=null;}
    };
    this.detailTask=this.detailTask.then(run,run);
  }
  installDetail(){
    const pending=this.pendingDetail;
    if(!pending||!this.studioActive||this.mode!=='selected'||this.selected!==pending.index||!this.cars.has(pending.index))return;
    const {index,holder}=pending,gallery=this.cars.get(index);
    this.pendingDetail=null;gallery.removeFromParent();
    holder.visible=true;this.applyPaint(holder,this.paintChoice.get(index));this.setCarAlpha(holder,1);
    this.scene.add(holder);this.cars.set(index,holder);this.detailResident={index,holder,gallery};
    this.refreshShadow();this.onDetailReady(index);
  }
  cancelDetail(){
    this.detailEpoch++;this.detailAbort?.abort();this.detailAbort=null;
    if(this.pendingDetail){disposeModel(this.pendingDetail.holder);this.pendingDetail=null;}
  }
  releaseDetail(){
    const d=this.detailResident;if(!d)return;
    this.detailResident=null;const visible=d.holder.visible;
    this.cars.set(d.index,d.gallery);d.gallery.visible=visible;
    this.applyPaint(d.gallery,this.paintChoice.get(d.index));this.setCarAlpha(d.gallery,1);
    d.gallery.traverse(n=>{if(n.isMesh)n.castShadow=false;});
    if(!this.disposed)this.scene.add(d.gallery);
    disposeModel(d.holder);
  }
  /* Glossy showroom paint: clearcoat on body materials, stronger env response
   * on metals/chrome, anisotropic filtering on every texture. */
  finishMaterials(holder) {
    const aniso = Math.min(8, this.renderer.getMaxAnisotropy());
    const swapped = new Map();
    const fadeMats = new Set(), opaqueMeshes = [], cutoutMeshes = [];
    holder.traverse(n => {
      if (!n.isMesh) return;
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      mats.forEach((mat, mi) => {
        if (!mat) return;
        let m = swapped.get(mat);
        if (!m) { m = this.tuneMaterial(mat); swapped.set(mat, m); fadeMats.add(m); }
        if (m !== mat) { if (Array.isArray(n.material)) n.material[mi] = m; else n.material = m; }
        this.tagPaint(m);
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'clearcoatNormalMap']) {
          if (m[key]) m[key].anisotropy = aniso;
        }
      });
      const m = Array.isArray(n.material) ? n.material[0] : n.material;
      if (m.alphaTest > 0) cutoutMeshes.push(n);
      else if (!m.transparent) opaqueMeshes.push(n);
    });
    Object.assign(holder.userData, { fadeMats: [...fadeMats], opaqueMeshes, cutoutMeshes });
  }
  /* Whole-car fade: opaque parts blend at renderOrder 10 so they composite over
   * the decals with depth intact (no x-ray); cutouts switch at the midpoint. */
  setCarAlpha(car, alpha) {
    const u = car.userData;
    u.displayAlpha = alpha;
    for (const m of u.fadeMats) m.opacity = m.userData.baseOpacity * alpha;
    const order = alpha < .999 ? 10 : 0;
    for (const n of u.opaqueMeshes) n.renderOrder = order;
    for (const n of u.cutoutMeshes) n.visible = alpha > .5;
  }
  tuneMaterial(mat) {
    const name = (mat.name || '').toLowerCase();
    if (/glass|window|light|lamp|emissive|tyre|tire|rubber|tread/.test(name) || mat.transmission > 0 || mat.opacity < .99) {
      mat.envMapIntensity = /glass|window/.test(name) ? 1.0 : .8;
      return mat;
    }
    // Leave physically authored trim and carbon alone; only broaden paint
    // highlights, keeping existing roughness textures and the base colour.
    const trim = /wheel|carbon|interior|intor|seat|engine|brake|caliper|calliper|disk|mirror|grill|badge|plate|speaker|susp|chrome/.test(name);
    const paint = !trim && (/paint|carpaint|body_color|coloured|_spec_|siny/.test(name) || (!mat.map && mat.roughness <= .28));
    if (paint) {
      let m = mat;
      if (!mat.isMeshPhysicalMaterial) {
        m = new THREE.MeshPhysicalMaterial({
          color: mat.color, map: mat.map, metalness: mat.metalness, roughness: mat.roughness,
          normalMap: mat.normalMap, normalScale: mat.normalScale, roughnessMap: mat.roughnessMap, metalnessMap: mat.metalnessMap,
          aoMap: mat.aoMap, aoMapIntensity: mat.aoMapIntensity, emissive: mat.emissive, emissiveMap: mat.emissiveMap, emissiveIntensity: mat.emissiveIntensity,
          alphaMap: mat.alphaMap, vertexColors: mat.vertexColors, flatShading: mat.flatShading,
          side: mat.side, transparent: mat.transparent, opacity: mat.opacity, alphaTest: mat.alphaTest, depthWrite: mat.depthWrite
        });
        m.name = mat.name;
      }
      m.clearcoat = Math.max(m.clearcoat || 0, .9);
      m.clearcoatRoughness = Math.max(m.clearcoatRoughness || 0, .12);
      if (!m.roughnessMap) m.roughness = Math.max(m.roughness ?? .16, .16);
      m.envMapIntensity = 1.1;
      return m;
    }
    mat.envMapIntensity = mat.metalness > .6 && mat.roughness < .45 ? 1.05 : .8;
    return mat;
  }
  /* Body-finish configurator: remember which materials carry the exterior
   * paint so a swatch can retint them without touching glass/trim/rubber. */
  tagPaint(m) {
    if (m.userData.isPaint) return;
    const name = (m.name || '').toLowerCase();
    if (/glass|window|light|lamp|rubber|tire|tyre|wheel|carbon|interior|intor|seat|engine|brake|caliper|calliper|disk|mirror|grill|badge|plate|speaker|susp|chrome/.test(name)) return;
    const chroma = Math.max(m.color.r, m.color.g, m.color.b) - Math.min(m.color.r, m.color.g, m.color.b);
    if (/paint|carpaint|body_color|coloured/.test(name) || (!m.map && chroma > .12)) {
      m.userData.isPaint = true;
      m.userData.baseColor = m.color.clone();
      m.userData.baseMap = m.map || null;
    }
  }
  collectPaint(holder) {
    const tris = new Map();
    holder.traverse(n => {
      if (!n.isMesh) return;
      const g = n.geometry;
      const count = (g.index ? g.index.count : g.attributes.position.count) / 3;
      for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
        if (m) tris.set(m, (tris.get(m) || 0) + count);
      }
    });
    let paint = [...tris.keys()].filter(m => m.userData.isPaint);
    // Keep only substantial panels: tiny saturated badges/calipers must not retint.
    const total = [...tris.values()].reduce((a, b) => a + b, 0);
    const min = Math.max(1500, total * .02);
    paint = paint.filter(m => (tris.get(m) || 0) >= min);
    if (!paint.length) {
      const skip = /glass|window|light|lamp|rubber|tire|tyre|wheel|carbon|interior|engine|brake|disk|mirror|grill|badge|plate|speaker|susp/;
      const ranked = [...tris.entries()]
        .filter(([m]) => !skip.test((m.name || '').toLowerCase()) && !m.transparent)
        .sort((a, b) => b[1] - a[1]);
      if (ranked.length) {
        const m = ranked[0][0];
        m.userData.isPaint = true;
        m.userData.baseColor = m.color.clone();
        m.userData.baseMap = m.map || null;
        paint = [m];
      }
    }
    const converted = new Map(paint.map(m => {
      const finish = createCarPaintMaterial(m, { coordinateScale: holder.scale.x });
      // The shader factory defaults to a very sharp .06 clearcoat. Broaden
      // this lobe locally for the showroom; keep the standalone package intact.
      finish.clearcoatRoughness = Math.max(m.clearcoatRoughness || 0, .12);
      if (!finish.roughnessMap) finish.roughness = Math.max(finish.roughness ?? .16, .16);
      finish.envMapIntensity = Math.min(finish.envMapIntensity ?? 1, 1.1);
      return [m, finish];
    }));
    holder.traverse(n => { if (n.isMesh && converted.has(n.material)) n.material = converted.get(n.material); });
    holder.userData.paintMats = [...converted.values()];
    holder.userData.fadeMats = holder.userData.fadeMats.map(m => converted.get(m) || m);
    for (const m of holder.userData.fadeMats) fadeReady(m);
  }
  applyPaint(holder, hex) {
    for (const m of holder.userData.paintMats || []) {
      if (hex) {
        // Baked base-color textures would multiply the chosen finish away.
        if (m.map) { m.map = null; m.needsUpdate = true; }
        m.color.set(hex);
      } else {
        if (m.userData.baseMap && !m.map) { m.map = m.userData.baseMap; m.needsUpdate = true; }
        m.color.copy(m.userData.baseColor);
      }
    }
    holder.userData.paint = hex || null;
  }
  setPaint(index, hex) {
    this.paintChoice.set(index, hex || null);
    const car = this.cars.get(index);
    if (car) this.applyPaint(car, hex || null);
    return !!car;
  }
  getPaint(index) { return this.paintChoice.get(index) || null; }
  buildPlaceholders() {
    this.placeholderGeo = silhouetteGeometry();
    for (let i = 0; i < this.homeCount; i++) {
      const v = this.vehicles[i];
      const mat = new THREE.MeshStandardMaterial({ color: 0x161d25, metalness: .75, roughness: .3, transparent: true, opacity: .45, envMapIntensity: .5, depthWrite: false });
      const m = new THREE.Mesh(this.placeholderGeo, mat);
      m.position.set(bayX(i), 0, carZ(i));
      m.rotation.y = .3 + (i >= this.perRow ? Math.PI : 0) + (NOSE_BACK.has(v.id) ? Math.PI : 0);
      m.renderOrder = 1;
      m.userData.index = i;
      this.scene.add(m);
      this.placeholders.set(i, m);
    }
  }

  /* --------------------------------------------------------------- input */
  bindInput() {
    const stage = this.stage;
    const listen = (type, handler, options) => this.inputLifetime.listen(stage, type, handler, options);
    listen('pointerdown', e => {
      if (this.mode !== 'home' || this.cinema || this.returning || e.target.closest('button,.overview-picker') || e.button !== 0) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, initial: this.position, base: Math.round(this.position), initialPan: this.ovPan, moved: false, lastVal: this.overview ? this.ovPan : this.position, lastT: performance.now(), vel: 0 };
      this.dragged = false; stage.style.cursor = '';
    });
    listen('pointermove', e => {
      const p = this.drag;
      if (!p || p.id !== e.pointerId || this.mode !== 'home' || this.cinema) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (!p.moved && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) { this.drag = null; return; }
      if (!p.moved && Math.abs(dx) < 8) return;
      if (!p.moved) { p.moved = true; this.dragged = true; stage.classList.add('dragging'); try { stage.setPointerCapture(e.pointerId); } catch {} }
      const now = performance.now();
      const dtp = Math.max(.001, (now - p.lastT) / 1000);
      if (this.overview) {
        const span = this.mobile ? 90 : 150;
        const target = clamp(p.initialPan - dx / span, -this.ovLimit, this.ovLimit);
        p.vel = p.vel * .7 + ((target - p.lastVal) / dtp) * .3;
        p.lastVal = target; this.ovTarget = target;
      } else {
        // One car per gesture: ease toward the neighbour, then hard-stop (detent).
        // The rear row faces the opposite way, so screen-left is index+1 there.
        const span = this.mobile ? 150 : 200;
        const dir = this.row === 1 ? -1 : 1;
        const [lo, hi] = this.rowBounds();
        const pos = clamp(p.base + clamp(-dx * dir / span, -1, 1), lo, hi);
        this.position = pos;
        this.setFocus(Math.round(pos), true);
      }
      p.lastT = now;
    });
    const end = e => {
      const p = this.drag;
      if (!p || e.pointerId !== p.id) return;
      const moved = p.moved; this.drag = null; stage.classList.remove('dragging');
      if (!moved) return;
      this.suppressUntil = performance.now() + 350;
      // Release with momentum: a flick glides onward, then settles to a bay.
      if (this.overview) this.ovTarget = clamp(this.ovTarget + p.vel * .12, -this.ovLimit, this.ovLimit);
      else {
        const [lo, hi] = this.rowBounds();
        this.setFocus(clamp(Math.round(this.position), lo, hi));
        // During drag, focus updates are silent. Commit the settled selection
        // to the UI only once after the gesture ends.
        this.onFocus(this.focus);
      }
      clearTimeout(this.dragResetTimer);
      this.dragResetTimer = setTimeout(() => { this.dragged = false; }, 40);
    };
    listen('pointerup', e => {
      const wasDrag = this.drag?.moved;
      end(e);
      if (!wasDrag && this.mode === 'home' && !this.cinema && !this.returning && !e.target.closest('button,.overview-picker') && performance.now() > this.suppressUntil) {
        const hit = this.pickCar(e.clientX, e.clientY);
        if (hit !== null) this.onSelect(hit);
      }
    });
    listen('pointercancel', end);
    // Overview hover: cheap floor-plane pick (no per-mesh raycast) lights a ring
    // under the pointed bay and glows its label.
    listen('pointermove', e => {
      if (this.mode !== 'home' || !this.overview || this.drag?.moved || e.target.closest('.overview-picker')) return;
      this.ovHover = this.pickBay(e.clientX, e.clientY);
      stage.style.cursor = this.ovHover !== null ? 'pointer' : '';
    });
    listen('pointerleave', () => { this.ovHover = null; stage.style.cursor = ''; });
    listen('dragstart', e => e.preventDefault());
    listen('wheel', e => {
      if (this.mode !== 'home' || this.returning || this.cinema || e.target.closest('.overview-picker') || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (this.overview) { this.ovTarget = clamp(this.ovTarget + (e.deltaX > 0 ? 2.5 : -2.5), -this.ovLimit, this.ovLimit); return; }
      // Touchpad: one car per swipe, then a short lock so it cannot chain.
      const now = performance.now();
      if (now < (this.wheelLock || 0)) return;
      this.wheelLock = now + 420;
      if (e.deltaX > 0) this.next(); else this.prev();
    }, { passive: false });
    this.inputLifetime.listen(window, 'resize', () => this.resize(), { passive: true });
  }
  /* Screen-right / screen-left: the rear row faces the other way, so its
   * index order runs opposite to the front row on screen. */
  // Do not sweep 45 meters across the entire hall when an arrow wraps a row.
  next() { if (this.cinema || this.returning || this.overview || this.mode !== 'home') return; const [lo, hi] = this.rowBounds(); this.setFocus(clamp(this.focus + (this.row === 1 ? -1 : 1), lo, hi)); }
  prev() { if (this.cinema || this.returning || this.overview || this.mode !== 'home') return; const [lo, hi] = this.rowBounds(); this.setFocus(clamp(this.focus + (this.row === 1 ? 1 : -1), lo, hi)); }
  pickCar(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const groups = [...this.cars.values(), ...this.placeholders.values()].filter(o => o.visible);
    const hits = this.raycaster.intersectObjects(groups, true);
    if (!hits.length) return null;
    let node = hits[0].object;
    while (node && node.userData.index === undefined) node = node.parent;
    return node?.userData.index ?? null;
  }
  /* Map a pointer to a bay by intersecting the floor plane (y=0) — far cheaper
   * than raycasting every parked mesh, and exact enough for a hover ring. */
  pickBay(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const ray = this.raycaster.ray;
    if (Math.abs(ray.direction.y) < 1e-4) return null;
    const t = -ray.origin.y / ray.direction.y;
    if (t < 0) return null;
    const x = ray.origin.x + ray.direction.x * t, z = ray.origin.z + ray.direction.z * t;
    if (Math.abs(x) > HALL_W / 2 || Math.abs(z) > HALL_DEPTH / 2) return null;
    const col = clamp(Math.round(x / BAY_W + 3.5), 0, 7);
    return (z > 0 ? 1 : 0) * this.perRow + col;
  }
  setFocus(i, silent = false) {
    if (this.returning) return;
    const [lo, hi] = this.rowBounds(rowOf(clamp(i, 0, this.bayCount - 1)));
    const next = clamp(i, lo, hi);
    this.target = next;
    this.row = rowOf(next);
    if (next !== this.focus) { this.focus = next; if (!silent) this.onFocus(next); }
    if (this.reduced) this.position = next;
    // Pointer-drag previews do not trigger expensive downloads until release.
    if (!silent) this.prioritize(next);
  }
  /* Flip between the front and rear gallery with a short crane across the hall. */
  toggleRow() {
    if (this.mode !== 'home' || this.overview || this.flight) return this.row;
    const row = 1 - this.row;
    const index = row * this.perRow + (this.focus % this.perRow);
    this.row = row; this.focus = index; this.target = index; this.position = index;
    this.layoutSpots(row);
    this.prioritize(index);
    const { pos, look } = this.homePose(index);
    this.flight = { t: 0, dur: this.reduced ? 0 : flightSeconds(this.camera.position, pos, FLIGHT_SECONDS.row), fromPos: this.camera.position.clone(), fromLook: this.currentLook(), toPos: pos, toLook: look, done: null };
    this.onFocus(index);
    return row;
  }

  /* ------------------------------------------------------ camera & modes */
  homePose(pos) {
    const rear = Math.round(pos) >= this.perRow;
    const x = bayX(pos);
    const z = (this.mobile ? 3.1 : 2.7) * (rear ? -1 : 1);
    return { pos: new THREE.Vector3(x, 1.62, z), look: new THREE.Vector3(x + .35, 1.02, rear ? -CAR_Z : CAR_Z) };
  }
  applyHomeCamera() {
    const { pos, look } = this.homePose(this.position);
    this.camera.position.copy(pos); this.camera.lookAt(look);
  }
  overviewPose(fov = this.mobile ? 60 : 50) {
    // setViewOffset mutates camera.aspect. Overview always uses the physical
    // viewport, even when returning from a cropped detail projection.
    const aspect = this.stage.clientWidth / Math.max(1, this.stage.clientHeight) || 1;
    const vFov = fov * Math.PI / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const halfW = HALL_W / 2 + 2;
    if (this.mobile || aspect < 1.1) {
      // Portrait: look down the long axis so the whole rectangle fits.
      const dist = clamp(Math.max((HALL_W / 2 + 2) / Math.tan(vFov / 2), (HALL_DEPTH / 2 + 2) / Math.tan(hFov / 2)) * 1.08, 26, 62);
      this.ovLimit = Math.max(2, HALL_DEPTH / 2 + 2 - Math.tan(hFov / 2) * dist * .92);
      return { pos: new THREE.Vector3(-dist * .62, dist * .78, this.ovPan), look: new THREE.Vector3(-.4, -1.5, this.ovPan) };
    }
    const dist = clamp(Math.max((halfW+.8) / Math.tan(hFov / 2)+3.3, 12 / Math.tan(vFov / 2)), 26, 50);
    this.ovLimit = Math.max(3, halfW - Math.tan(hFov / 2) * dist * .92);
    return { pos: new THREE.Vector3(this.ovPan, dist * .78, dist * .62), look: new THREE.Vector3(this.ovPan, .4, -.4) };
  }
  applyOverviewCamera() {
    const { pos, look } = this.overviewPose();
    // Idle cinematic breathing: a slow dolly + lateral sway keeps the aerial
    // alive; it eases out while the visitor pans or a flight is running.
    if (!this.reduced && this.overview) {
      const idle = !this.drag?.moved && !this.flight ? 1 : 0;
      this.ovDrift += (idle - this.ovDrift) * .04;
      const t = performance.now() / 1000, k = this.ovDrift;
      pos.x += Math.sin(t * .11) * 1.1 * k;
      pos.y += Math.sin(t * .07) * .5 * k;
      pos.z += Math.cos(t * .09) * .7 * k;
      look.x += Math.sin(t * .11) * .5 * k;
    }
    this.camera.position.copy(pos); this.camera.lookAt(look);
  }
  applyOverviewState(on, resize = true) {
    this.overview = on;
    this.stage.classList.toggle('is-overview', on);
    if (on) {
      this.ovOpenAt = performance.now();
      if (!this.returning && this.overviewChoice) this.overviewChoice.value = String(this.focus);
    } else this.ovHover = null;
    this.ovSweep.visible = on;
    this.ceilGroup.visible = !on;
    this.southGroup.visible = !on;
    if (this.refl) {
      this.reflectOn = !on;
      this.uVeil.value = on ? 1 : .78;
      if (on) this.uReflect.value = 0;
    }
    this.scene.fog.density = on ? FOG_OVERVIEW : FOG_HOME;
    // Overview must reveal every bay: undo the home neighbourhood culling so
    // distant machines are not left hidden when the aerial view opens.
    if (on) {
      for (const [i, car] of this.cars) if (!this.fades.has(i)) car.visible = true;
      for (const [i, ph] of this.placeholders) if (!this.fades.has(i)) ph.visible = !this.cars.has(i);
    }
    if (resize) this.resize();
    this.reflDirty = true;
    if (!on) { this.ovPan = 0; this.ovTarget = 0; }
    this.onOverview(on);
  }
  toggleOverview() {
    if (this.mode !== 'home' || this.returning || this.flight?.cinema) return;
    const on = !this.overview;
    this.applyOverviewState(on, false);
    if (on) this.enqueueAround(this.focus);
    const to = on ? this.overviewPose() : this.homePose(this.position);
    this.flight = { t: 0, dur: this.reduced ? 0 : flightSeconds(this.camera.position, to.pos, FLIGHT_SECONDS.overview), fromPos: this.camera.position.clone(), fromLook: this.currentLook(), toPos: to.pos, toLook: to.look, done: null };
  }
  heroYaw(index) {
    const yaw = this.mobile ? 1.05 : .62;
    const sz = index < this.perRow ? 1 : -1;
    const dist = this.mobile ? 9.6 : 6.6;
    // The outer bays must be filmed from inside the hall, never through a wall.
    return Math.abs(bayX(index) + Math.sin(yaw) * dist * sz) > HALL_W / 2 - 1.5 ? -yaw : yaw;
  }
  heroPose(index) {
    const look = new THREE.Vector3(bayX(index), .78, carZ(index));
    const yaw = this.heroYaw(index), dist = this.mobile ? 9.6 : 6.6;
    const sz = index < this.perRow ? 1 : -1;
    return { look, pos: look.clone().add(new THREE.Vector3(Math.sin(yaw) * dist * sz, 1.42, Math.cos(yaw) * dist * sz)) };
  }
  setAutoShot(on) {
    this.autoShot = null;
    if (on && !this.reduced && this.mode === 'selected' && this.studioActive && this.controls?.enabled) {
      const offset = this.camera.position.clone().sub(this.controls.target);
      this.autoShot = { elapsed: 0, yaw: Math.atan2(offset.x, offset.z), radius: Math.hypot(offset.x, offset.z), height: offset.y, direction: this.heroYaw(this.selected) < 0 ? -1 : 1 };
      this.reflectOn = false; this.pendingReflectRestore = 0;
    } else if (this.mode === 'selected' && !this.flight && !this.studioActive) this.pendingReflectRestore = 1.15;
    this.stage.dispatchEvent(new CustomEvent('velance:auto-shot', { detail: !!this.autoShot }));
  }
  advanceAutoShot(dt) {
    const shot = this.autoShot;
    if (!shot || !this.controls?.enabled || !this.cars.has(this.selected)) return;
    shot.elapsed += Math.min(dt, .034);
    // A short settling beat, then a continuous 360-degree track. Vary the
    // radius and elevation slowly instead of spinning the model or hard-cutting.
    const t = Math.max(0, shot.elapsed - 1.25);
    const ramp = 1.1;
    const travel = t < ramp ? t * t / (2 * ramp) : t - ramp / 2;
    const phase = travel * Math.PI * 2 / 14;
    const yaw = shot.yaw + shot.direction * (phase + .16 * Math.sin(phase * 2));
    const amount = (1 - Math.cos(phase)) / 2;
    const radius = shot.radius * (1 - .045 * amount);
    const height = shot.height + (this.mobile ? .35 : .55) * Math.sin(phase) ** 2;
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(Math.sin(yaw) * radius, height, Math.cos(yaw) * radius));
    this.camera.lookAt(this.controls.target);
  }
  setStudio(on) {
    this.studioActive = on;
    this.studioGroup.visible = on;
    this.hallArchitecture.visible = !on;
    if (on) {
      this.studioGroup.position.set(bayX(this.selected), 0, carZ(this.selected));
      this.overviewApron.visible = false;
      this.reflectOn = false; this.pendingReflectRestore = 0;
      this.detailSet.visible = false;
      for (const [i, car] of this.cars) car.visible = i === this.selected;
      for (const ph of this.placeholders.values()) ph.visible = false;
      this.installDetail();
    } else this.releaseDetail();
    this.refreshShadow();
  }
  studioFade(value) {
    this.studioCurtain.style.opacity = String(clamp(value, 0, 1));
  }
  select(index, hostEl, onReveal = () => {}, onLanded = () => {}) {
    if (this.mode !== 'home' || this.cinema || this.returning) return;
    const fromPos = this.camera.position.clone(), fromQuat = this.camera.quaternion.clone();
    const fromLook = this.currentLook(), fromFov = this.camera.fov;
    const wasOverview = this.overview;
    if (wasOverview && this.overviewChoice) this.overviewChoice.value = String(index);
    this.selectionOrigin = { overview: wasOverview, pan: this.ovPan, focus: this.focus, row: this.row, fov: fromFov };
    if (wasOverview) this.applyOverviewState(false, false);
    if (this.refl) { this.reflectOn = false; this.uReflect.value = 0; }
    this.mode = 'selected'; this.selected = index; this.row = rowOf(index);
    this.focus = this.target = this.position = index; this.onFocus(index);
    this.drag = null; this.dragged = false; this.stage.classList.remove('dragging');
    this.prioritize(index);
    this.requestDetail(index);
    this.stage.classList.add('is-selected');
    this.fades.clear();
    for (const [i, car] of this.cars) {
      this.setCarAlpha(car, 1);
      car.visible = i === index || wasOverview || car.visible;
    }
    for (const [i, ph] of this.placeholders) ph.visible = i === index;
    const { look: center, pos: endPos } = this.heroPose(index);
    this.detailHost = hostEl;
    const sz = index < this.perRow ? 1 : -1;
    const side = Math.sign(endPos.x - center.x);
    const high = fromPos.y > CEIL_Y;
    // Crane across the hall above the roof, then swing around the car from
    // the central aisle. The final tangent is lower and more lateral.
    const c1 = high
      ? new THREE.Vector3(THREE.MathUtils.lerp(fromPos.x, center.x, .72), Math.max(8, fromPos.y * .82), fromPos.z * .28)
      : new THREE.Vector3(THREE.MathUtils.lerp(fromPos.x, center.x, .45) - side * 1.6, 3.5, clamp(fromPos.z, -2.8, 2.8));
    const c2 = new THREE.Vector3(clamp(endPos.x - side * 3.2, -HALL_W / 2 + 2, HALL_W / 2 - 2), high ? 7.2 : 3.4, clamp(endPos.z + sz * 1.4, -3.4, 3.4));
    const arcLut = cameraArcLut(fromPos, c1, c2, endPos);
    // The artwork and spec panel start revealing late in the camera movement.
    // Delay high-resolution editorial image work until the camera has landed.
    this.controls = new OrbitControls(this.camera, hostEl);
    this.controls.enabled = false;
    this.controls.addEventListener('change', () => { this.lastOrbitAt = performance.now(); });
    this.controls.addEventListener('start', () => this.setAutoShot(false));
    this.controls.enableDamping = true; this.controls.dampingFactor = .07;
    this.controls.enablePan = false; this.controls.enableZoom = false;
    this.controls.rotateSpeed = .55;
    this.controls.minDistance = 4.4; this.controls.maxDistance = 10.5;
    // The camera remains below the fixed studio wall even after manual orbit
    // and restarting AUTO from the highest permitted viewpoint.
    this.controls.minPolarAngle = 1.0; this.controls.maxPolarAngle = 1.46;
    hostEl.style.touchAction = 'none';
    this.controls.target.copy(center);
    // OrbitControls' constructor calls update() with its default origin.
    // Restore the actual opening frame until the intentional handoff.
    this.camera.position.copy(fromPos); this.camera.quaternion.copy(fromQuat);
    this.pendingReflectRestore = 0;
    // The car casts its first shadow well before landing so the last frame
    // does not force a new shadow-map pass just as orbit is enabled.
    const car = this.cars.get(index);
    if (car) car.traverse(n => { if (n.isMesh) n.castShadow = true; });
    this.keyShadow.position.set(bayX(index) + 2.5 * sz, CEIL_Y - .3, index < this.perRow ? -2.4 : 2.4);
    this.keyShadow.target.position.copy(center);
    this.keyShadow.intensity = 0;
    this.refreshShadow();
    this.placeDetailSet(index);
    // Prewarm the scene dressing now; reveal it through opacity instead of
    // toggling it on for the first time halfway through a GPU-heavy flight.
    this.detailSet.visible = true;
    for (const piece of this.detailSet.children) {
      if (piece.userData.originalOpacity === undefined) piece.userData.originalOpacity = piece.material.opacity;
      piece.material.opacity = 0;
    }
    this.flight = {
      t: 0, dur: this.reduced ? 0 : clamp(arcLut.length / 10.5, FLIGHT_SECONDS.select, 5.2),
      selection: true, fromPos, fromLook,
      c1, c2, toPos: endPos, toLook: center, framing: 0,
      fromQuat, fromFov, arcLut, wasOverview, aimQuat: new THREE.Quaternion(), aimMatrix: new THREE.Matrix4(),
      onReveal,
      done: () => {
        this.camera.fov = fromFov;
        this.frameViewOffset(1);
        this.controls.enabled = true;
        this.controls.update();
        // Rebuild the expensive mirror only after the final camera frame and
        // the selected UI have settled. A mirror pass mid-flight caused a
        // measured ~100 ms WebGL2 stall on the first cold enable.
        this.setStudio(true); this.studioFade(0);
        onLanded();
        this.setAutoShot(true);
      }
    };
  }
  frameViewOffset(amount = 1) {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    const progress = clamp(amount, 0, 1);
    this.framing = progress;
    if (progress <= 0) {
      this.camera.clearViewOffset();
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
      return;
    }
    if (this.mobile) {
      // Fit the car's projected span to the detail host width, then centre the
      // look-at point in that host instead of the full-height stage.
      const host = this.detailHost;
      const hostW = host?.offsetWidth > 40 ? host.offsetWidth : w * .9;
      let centerY = host ? host.offsetHeight / 2 : h * .29;
      // Layout coordinates exclude the panel's reveal/exit CSS transform.
      for (let el = host; el && el !== this.stage.parentElement; el = el.offsetParent) centerY += el.offsetTop;
      const fullH = 2 * 9.6 * Math.tan(this.camera.fov * Math.PI / 360) * hostW / 4.6;
      const interpolatedH = h + (fullH - h) * progress;
      this.camera.setViewOffset(w, interpolatedH, 0, (fullH / 2 - centerY) * progress, w, h);
    } else this.camera.setViewOffset(w * (1 + .42 * progress), h, w * .42 * progress, 0, w, h);
    this.camera.updateProjectionMatrix();
  }
  clearSelection() {
    if (this.mode !== 'selected') return;
    const index = this.selected;
    const origin = this.selectionOrigin || { overview: false, pan: 0, focus: index, row: rowOf(index), fov: this.mobile ? 60 : 50 };
    const fromPos = this.camera.position.clone(), fromQuat = this.camera.quaternion.clone();
    const fromFraming = this.framing || 0, fromFov = this.camera.fov;
    const look = this.currentLook();
    const fromStudio = this.studioActive;
    this.cancelDetail();
    this.setAutoShot(false);
    this.controls?.dispose(); this.controls = null;
    if (this.detailHost) this.detailHost.style.touchAction = '';
    this.mode = 'home'; this.selected = null;
    this.returning = true;
    this.stage.classList.add('is-returning');
    this.drag = null; this.dragged = false; this.ovHover = null;
    this.stage.classList.remove('dragging'); this.stage.style.cursor = '';
    const detailAlpha = this.detailSet.children[0].material.opacity / this.detailSet.children[0].userData.originalOpacity;
    const shadowIntensity = this.keyShadow.intensity;
    this.stage.classList.remove('is-selected');
    this.fades.clear();
    this.focus = origin.overview ? origin.focus : index;
    this.row = origin.overview ? origin.row : rowOf(index);
    this.position = this.target = this.focus;
    this.ovPan = this.ovTarget = origin.pan; this.ovDrift = 0;
    this.applyOverviewState(origin.overview, false);
    this.onFocus(this.focus);
    const restoreAlpha = new Map([...this.cars].map(([i, car]) => [i, car.userData.displayAlpha ?? 1]));
    for (const [i, ph] of this.placeholders) ph.visible = !this.cars.has(i) && (origin.overview || rowOf(i) === this.row);
    const car = this.cars.get(index);
    if (car) car.traverse(n => { if (n.isMesh) n.castShadow = false; });
    this.pendingReflectRestore = 0;
    this.reflectOn = false;
    this.refreshShadow();
    const { pos, look: homeLook } = origin.overview ? this.overviewPose(origin.fov) : this.homePose(this.position);
    const c1 = fromPos.clone().lerp(pos, .24); c1.y = Math.max(c1.y, fromStudio ? 9.5 : origin.overview ? 7.5 : 2.8);
    if (origin.overview) c1.z = clamp(fromPos.z, -3.5, 3.5);
    const c2 = fromPos.clone().lerp(pos, .76); if (origin.overview || fromStudio) c2.y = Math.max(origin.overview ? 8 : 5.8, c2.y);
    const arcLut = cameraArcLut(fromPos, c1, c2, pos);
    const toQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, homeLook, this.camera.up));
    this.flight = { t: 0, returning: true, dur: this.reduced ? 0 : clamp(arcLut.length / 11, FLIGHT_SECONDS.return, 4.6),
      fromPos, fromLook: look, toPos: pos, toLook: homeLook, c1, c2, arcLut, fromQuat, toQuat,
      fromFov, toFov: origin.fov, fromFraming, framing: fromFraming, restoreAlpha, detailAlpha, shadowIntensity, fromStudio, index,
      done: () => {
        this.returning = false; this.selectionOrigin = null;
        this.setStudio(false); this.studioFade(0);
        this.stage.classList.remove('is-returning');
        this.detailSet.visible = false; this.keyShadow.intensity = 0;
        this.camera.fov = origin.fov; this.frameViewOffset(0); this.detailHost = null;
        for (const car of this.cars.values()) this.setCarAlpha(car, 1);
        this.reflectOn = !origin.overview; this.reflDirty = true;
      } };
  }
  currentLook() {
    const dir = new THREE.Vector3(); this.camera.getWorldDirection(dir);
    return this.camera.position.clone().add(dir.multiplyScalar(10));
  }
  bayLightLevel(i) {
    if (!this.lightReveal) return 1;
    if (!this.cars.has(i)) return 0;
    if (this.reduced) return 1;
    return cameraEase(clamp((this.lightReveal.elapsed - bayRevealOrder(i) * .16) / .68, 0, 1));
  }
  finishCinema(stayOverview = false) {
    this.cinema = false;
    this.lightReveal = null;
    if (this.overview && !stayOverview) this.applyOverviewState(false);
    else if (stayOverview) {
      for (const car of this.cars.values()) car.visible = true;
      this.ovSweep.visible = true;
      this.onOverview(true);
    }
    this.stage.classList.remove('is-cinema-descending');
    this.reflectOn = !stayOverview;
    this.reflDirty = true;
  }
  /* Reveal real cars in order; the first visit stays at the collection view. */
  entrance({ stayOverview = false } = {}) {
    if ((this.reduced && !stayOverview) || this.mode !== 'home' || this.overview || this.flight) return false;
    this.prepareEntrance();
    const { pos, look } = this.homePose(this.position);
    this.cinema = true;
    this.stage.classList.remove('is-cinema-descending');
    // Start after the entrance gate has lifted so the first bay is visible.
    this.lightReveal = { elapsed: -.95 };
    this.applyOverviewState(true);
    for (const car of this.cars.values()) car.visible = false;
    for (const ph of this.placeholders.values()) ph.visible = false;
    this.ovSweep.visible = false;
    for (const spot of this.spots) spot.intensity = 0;
    for (const light of this.overviewLights) light.intensity = 0;
    for (const fixture of this.bayFixtures) fixture.material.emissiveIntensity = .05;
    for (const wash of this.washes) wash.material.opacity = 0;
    for (const pool of this.pools) pool.material.opacity = 0;
    for (const shaft of this.shafts) shaft.material.opacity = 0;
    // Reflections remain off throughout the overhead reveal, then ramp in.
    this.reflectOn = false;
    if (this.refl) this.uReflect.value = 0;
    const from = this.overviewPose();
    this.camera.position.copy(from.pos);
    this.camera.lookAt(from.look);
    this.flight = {
      t: 0, dur: stayOverview ? 4.55 : FLIGHT_SECONDS.entrance, hold: FLIGHT_SECONDS.entranceHold,
      cinema: true, stayOverview, fromPos: from.pos, fromLook: from.look,
      toPos: stayOverview ? from.pos : pos, toLook: stayOverview ? from.look : look,
      done: () => this.finishCinema(stayOverview)
    };
    return true;
  }
  resetView() {
    if (this.mode !== 'selected' || !this.controls?.enabled || this.flight) return;
    this.setAutoShot(false);
    const { pos, look } = this.heroPose(this.selected);
    this.camera.position.copy(pos); this.controls.target.copy(look);
    this.controls.update();
    this.setAutoShot(true);
  }
  resize() {
    const w = Math.max(1, this.stage.clientWidth), h = Math.max(1, this.stage.clientHeight);
    // A pixel budget matters more than DPR on a large Retina display.
    // Safari also avoids adaptive framebuffer reallocations during orbit.
    if(w!==this.lastSize.w||h!==this.lastSize.h){
      this.basePixelRatio=Math.min(this.maxPixelRatio,Math.sqrt(this.pixelBudget/(w*h)));
      this.pixelRatio=this.basePixelRatio;this.renderer.setPixelRatio(this.pixelRatio);
    }
    const pr = this.renderer.getPixelRatio();
    // Reallocating the drawing buffer stalls ~90ms; only do it on real changes.
    if (w !== this.lastSize.w || h !== this.lastSize.h || pr !== this.lastSize.pr) {
      this.lastSize = { w, h, pr };
      this.renderer.setSize(w, h, false);
      // ~512 px tall mirror, like the old fixed 512² target but aspect-correct.
      if (this.refl) { this.refl.reflector.resolutionScale = Math.min(.5, 512 / (h * pr)); this.reflDirty = true; }
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.returning) this.frameViewOffset(this.flight?.framing ?? this.framing ?? 0);
    else if (this.mode === 'selected') this.frameViewOffset(this.flight?.selection ? this.flight.framing : 1);
    else if (this.overview && !this.flight) this.applyOverviewCamera();
  }

  /* ---------------------------------------------------------------- loop */
  frame(now) {
    // Compile and upload during the portal, but do not draw a second scene
    // behind its opaque animated overlay. The first visible frame is ENTER.
    if (this.disposed || document.hidden || document.body.classList.contains('gate-open')) return;
    const rect = this.stage.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= innerHeight) return;
    const settling = this.mode === 'home' && !this.flight && (this.overview ? Math.abs(this.ovTarget - this.ovPan) > .001 : Math.abs(this.target - this.position) > .002);
    const orbitActive = !!this.controls?.enabled && (!!this.autoShot || now - this.lastOrbitAt < 160);
    const interacting = !!this.drag?.moved || !!this.flight || orbitActive || settling || this.fades.size > 0;
    const idleInterval = this.mobile ? 1000 / 24 : 1000 / 30;
    if (!interacting && now - this.lastDraw < idleInterval) return;
    const dt = Math.min(.05, (now - (this.lastNow || now)) / 1000) || .016;
    if (interacting && this.lastNow) {
      this.cadence.push(now - this.lastNow);
      if (this.cadence.length > 90) this.cadence.shift();
    }
    this.lastNow = now; this.lastDraw = now;
    const t0 = performance.now();

    // eased hall pan (or overview glide)
    if (this.mode === 'home' && !this.flight) {
      if (this.overview) {
        const d = this.ovTarget - this.ovPan;
        if (Math.abs(d) > .001) this.ovPan += d * (1 - Math.exp(-dt / .3));
        this.applyOverviewCamera();
      } else {
        // While dragging, the camera follows the finger directly (no snap-fight);
        // on release it eases toward the momentum target.
        if (!this.drag?.moved) {
          const diff = this.target - this.position;
          if (Math.abs(diff) > .0005) {
            // Cap the maximum distance per second for far-away bay jumps too.
            this.position += clamp(diff * (1 - Math.exp(-dt / .34)), -dt * 1.6, dt * 1.6);
            if (Math.abs(this.target - this.position) < .002) this.position = this.target;
            const [lo, hi] = this.rowBounds();
            this.focus = clamp(Math.round(this.position), lo, hi);
          }
        }
        this.applyHomeCamera();
      }
    }
    // Cap elapsed time per rendered frame: a slow shader/texture upload cannot
    // teleport the camera forward by several meters after one missed frame.
    if (this.flight) {
      const f = this.flight;
      let elapsed = (f.elapsed || 0) + Math.min(dt, .034);
      if (f.cinema) {
        const waiting = this.revealOrder.find(i => !this.cars.has(i) && !this.loadFailures.has(i));
        // Never advance past an unprepared bay. Previously lit cars remain lit
        // while the bounded background queue catches up; a failed bay stays dark.
        if (waiting !== undefined) elapsed = Math.min(elapsed, .95 + bayRevealOrder(waiting) * .16);
        else if (this.reduced) elapsed = f.dur;
        this.lightReveal.elapsed = elapsed - .95;
      }
      f.elapsed = elapsed;
      f.t = f.dur === 0 ? 1 : Math.min(1, f.elapsed / f.dur);
      if (f.cinema && !f.stayOverview && f.elapsed >= f.hold) this.stage.classList.add('is-cinema-descending');
      const k = cameraEase(f.hold ? clamp((f.elapsed - f.hold) / (f.dur - f.hold), 0, 1) : f.t);
      if (f.selection) {
        const progress = cameraEase(f.t);
        const bezierT = arcParameter(f.arcLut, progress);
        cubicPoint(this.camera.position, f.fromPos, f.c1, f.c2, f.toPos, bezierT);
        // Acquire the subject early, then keep the lens on it throughout the
        // crane and lateral dolly instead of rotating toward a static endpoint.
        f.aimQuat.setFromRotationMatrix(f.aimMatrix.lookAt(this.camera.position, f.toLook, this.camera.up));
        this.camera.quaternion.slerpQuaternions(f.fromQuat, f.aimQuat, cameraEase(clamp(f.t / .34, 0, 1)));
        this.camera.fov = f.fromFov - 5 * Math.sin(Math.PI * f.t) ** 2;
        f.framing = cinemaEase(clamp((f.t - .48) / .49, 0, 1));
        this.frameViewOffset(f.framing);
        const otherAlpha = 1 - cameraEase(clamp((f.t - .20) / .38, 0, 1));
        for (const [i, car] of this.cars) if (i !== this.selected && car.visible) {
          this.setCarAlpha(car, otherAlpha); car.visible = otherAlpha > .01;
        }
        // Build the highlight from near-dark to warm gold, then a final rim.
        // Both camera projection and light levels are settled before orbit.
        const light = cameraEase(clamp((f.t - .2) / .43, 0, 1));
        const detail = cameraEase(clamp((f.t - .34) / .43, 0, 1));
        this.keyShadow.intensity = 195 * light;
        for (const piece of this.detailSet.children) {
          piece.material.opacity = piece.userData.originalOpacity * detail;
        }
        if (f.t >= .79 && !f.revealed) { f.revealed = true; f.onReveal(); }
        if (f.t >= .87 && !this.studioActive) this.setStudio(true);
        this.studioFade(this.reduced ? 0 : f.t < .87 ? cameraEase(clamp((f.t-.76)/.11,0,1)) : 1-cameraEase(clamp((f.t-.87)/.13,0,1)));
      } else if (f.returning) {
        cubicPoint(this.camera.position, f.fromPos, f.c1, f.c2, f.toPos, arcParameter(f.arcLut, k));
        this.camera.quaternion.slerpQuaternions(f.fromQuat, f.toQuat, k);
        this.camera.fov = THREE.MathUtils.lerp(f.fromFov, f.toFov, k);
        f.framing = f.fromFraming * (1 - cameraEase(clamp(f.t / .65, 0, 1)));
        this.frameViewOffset(f.framing);
        const reveal = cameraEase(clamp((f.t - .12) / .60, 0, 1));
        for (const [i, car] of this.cars) {
          const a = THREE.MathUtils.lerp(f.restoreAlpha.get(i) ?? 1, 1, reveal);
          this.setCarAlpha(car, a);
          car.visible = a > .01 && (this.overview || (rowOf(i) === this.row && Math.abs(i - this.focus) <= (this.mobile ? 1 : 2)));
        }
        this.keyShadow.intensity = f.shadowIntensity * (1 - reveal);
        for (const piece of this.detailSet.children) piece.material.opacity = piece.userData.originalOpacity * f.detailAlpha * (1 - reveal);
        if (f.fromStudio) {
          if (f.t >= .20 && this.studioActive) this.setStudio(false);
          this.studioFade(this.reduced ? 0 : f.t < .20 ? cameraEase(clamp(f.t/.20,0,1)) : 1-cameraEase(clamp((f.t-.20)/.17,0,1)));
          if (this.studioActive) for (const [i, car] of this.cars) car.visible = i === f.index;
        } else this.studioFade(0);
      } else {
        this.camera.position.lerpVectors(f.fromPos, f.toPos, k);
        const look = new THREE.Vector3().lerpVectors(f.fromLook, f.toLook, k);
        this.camera.lookAt(look);
      }
      if (f.t >= 1) { this.flight = null; this.cadence.length = 0; f.done?.(); }
    }
    if (this.pendingReflectRestore > 0 && !this.flight) {
      // Never re-enable a costly mirror pass while the visitor is orbiting.
      // The reflection can catch up only after the view has been idle.
      if (now - this.lastOrbitAt > 650) {
        this.pendingReflectRestore = Math.max(0, this.pendingReflectRestore - dt);
      }
      if (this.pendingReflectRestore === 0 && this.mode === 'selected') {
        this.reflectOn = true;
        this.reflDirty = true;
      }
    }
    if (this.controls?.enabled) {
      this.advanceAutoShot(dt);
      this.controls.update();
    }

    // whole-car fades for non-selected machines
    for (const [i, fade] of this.fades) {
      const k = Math.min(1, (now - fade.start) / 600);
      const alpha = fade.from + (fade.to - fade.from) * easeInOut(k);
      const car = this.cars.get(i);
      if (car) {
        car.visible = alpha > .01;
        this.setCarAlpha(car, alpha);
      }
      if (rowOf(i) === this.spotRow) { const sp = this.spots.find(s => s.userData.bay === i); if (sp) sp.intensity = 110 * (.25 + .75 * alpha); }
      if (k >= 1) this.fades.delete(i);
    }

    // ghost silhouettes breathe until their real GLB parks, then dissolve
    for (const [i, ph] of this.placeholders) {
      if (ph.userData.dying) {
        ph.material.opacity -= dt * 2.4;
        if (ph.material.opacity <= 0) {
          this.scene.remove(ph); ph.material.dispose(); this.placeholders.delete(i);
          if (!this.placeholders.size) { this.placeholderGeo.dispose(); this.placeholderGeo = null; }
        }
      } else if (!this.reduced) {
        ph.material.opacity = .4 + Math.sin(now / 900 + i * 1.7) * .08;
      }
    }

    // focused-bay light breathing + emphasis; overview cross-fades to its two
    // directionals by intensity alone
    const ease = Math.min(1, dt * 5);
    const breathe = this.reduced ? 0 : Math.sin(now / 1700) * .05;
    const litRow = this.mode === 'selected' ? rowOf(this.selected) : this.row;
    this.layoutSpots(litRow);
    const selectionLight = this.flight?.selection
      ? cameraEase(clamp((this.flight.t - .2) / .43, 0, 1)) : 1;
    for (const spot of this.spots) {
      const i = spot.userData.bay ?? litRow * this.perRow;
      const focused = i === this.focus && this.mode === 'home' && !this.overview;
      const base = this.mode === 'selected' ? (i === this.selected ? 48 + 117 * selectionLight : 11 + 15 * selectionLight) : this.cinema ? 210 * this.bayLightLevel(i) : this.overview ? 0 : (focused ? 250 : 95);
      spot.intensity += (base * (1 + (focused ? breathe : 0)) - spot.intensity) * ease;
      spot.position.lerp(spot.userData.gp, ease);
      spot.target.position.lerp(spot.userData.gt, ease);
    }
    // Overview: a slow champagne band crosses the floor; each bay brightens as
    // it passes, bays cascade alight on open, and the hovered bay gets a ring.
    if (this.overview && !this.cinema) {
      this.ovSweepX = ((now / 1000 * 3.2) % (HALL_W + 10)) - HALL_W / 2 - 5;
      this.ovSweep.position.x = this.ovSweepX;
      this.ovSweep.material.opacity += (.12 * K_ADD - this.ovSweep.material.opacity) * ease;
    }
    for (let i = 0; i < this.bayCount; i++) {
      const focused = i === this.focus && this.mode === 'home' && !this.overview;
      let washTarget = K_ADD * (this.mode === 'selected' ? (i === this.selected ? .2 + .8 * selectionLight : .06) : this.overview ? .5 : focused ? .8 : .38);
      let poolTarget = K_ADD * (this.mode === 'selected' ? (i === this.selected ? .1 + .64 * selectionLight : .04) : this.overview ? .3 : focused ? .5 : .22);
      if (this.cinema) {
        const reveal = this.bayLightLevel(i);
        washTarget = K_ADD * 1.3 * reveal;
        poolTarget = K_ADD * .85 * reveal;
      } else if (this.overview) {
        const reveal = this.reduced ? 1 : easeInOut(clamp((now - this.ovOpenAt - i * 45) / 600, 0, 1));
        const d = bayX(i) - this.ovSweepX;
        const pulse = Math.exp(-(d * d) / 24);
        const hov = i === this.ovHover ? .22 : 0;
        washTarget = K_ADD * (.5 + .35 * pulse + hov) * reveal;
        poolTarget = K_ADD * (.3 + .4 * pulse + hov) * reveal;
      }
      // A genuinely unavailable model must not look like a successfully lit bay
      // when the entrance hands off to the steady collection view.
      const missing = this.overview && this.loadFailures.has(i) && !this.cars.has(i);
      if (missing) { washTarget = 0; poolTarget = 0; }
      this.washes[i].material.opacity += (washTarget - this.washes[i].material.opacity) * ease;
      this.pools[i].material.opacity += (poolTarget - this.pools[i].material.opacity) * ease;
      const fixtureTarget = missing ? .05 : this.cinema ? .05 + 5 * this.bayLightLevel(i) : this.mode === 'selected' ? (i === this.selected ? .5 + 4.2 * selectionLight : .35) : focused ? 3.1 : 1.25;
      this.bayFixtures[i].material.emissiveIntensity += (fixtureTarget - this.bayFixtures[i].material.emissiveIntensity) * ease;
    }
    if (this.ovHoverRing) {
      const on = this.overview && this.ovHover !== null;
      if (on) this.ovHoverRing.position.set(bayX(this.ovHover), .02, carZ(this.ovHover));
      const target = on ? .5 * K_ADD : 0;
      this.ovHoverRing.material.opacity += (target - this.ovHoverRing.material.opacity) * ease;
      this.ovHoverRing.visible = this.ovHoverRing.material.opacity > .01 * K_ADD;
    }
    for (const light of this.overviewLights) light.intensity += ((this.overview ? light.userData.on * (this.cinema ? .13 : 1) : 0) - light.intensity) * ease;
    if (this.refl) this.uReflect.value += ((this.reflectOn ? 1 : 0) - this.uReflect.value) * Math.min(1, dt * 6);

    // Home only renders the focused neighbourhood; distant machines stay culled.
    // Transparent dressing (washes, pools, shafts, contacts) is culled with them
    // so mobile never pays full-hall additive overdraw.
    const hood = this.mobile ? 1 : 2;
    const lowCam = this.camera.position.y < CEIL_Y - .5;
    const filming = this.mode === 'selected' || this.returning;
    const cameraPos = this.camera.position;
    this.northGroup.visible = !filming || cameraPos.z > WALL_Z + .85;
    for (const [side, group] of this.sideGroups) group.visible = !filming || side * cameraPos.x < HALL_W / 2 - .85;
    this.overviewApron.visible = !this.studioActive && (this.overview || !!this.flight || cameraPos.y > CEIL_Y + 1);
    if (this.mode === 'selected' || this.returning || this.flight) {
      const inside = Math.abs(this.camera.position.z) < 7 && Math.abs(this.camera.position.x) < HALL_W / 2 - .5;
      this.ceilGroup.visible = lowCam && inside;
      this.southGroup.visible = filming ? lowCam && cameraPos.z < -WALL_Z - .85 : lowCam && inside;
    } else { this.ceilGroup.visible = !this.overview; this.southGroup.visible = !this.overview; }
    for (let i = 0; i < this.bayCount; i++) {
      this.bayLowFixtures[i].visible = i < this.perRow ? !this.northGroup.visible : !this.southGroup.visible;
      const on = this.overview ? true : this.mode === 'selected' ? i === this.selected || (!!this.flight?.selection && this.flight.t < .58 && !!this.cars.get(i)?.visible) : rowOf(i) === this.row && Math.abs(i - this.focus) <= hood;
      this.washes[i].visible = on;
      this.pools[i].visible = on;
      this.shafts[i].visible = on && (this.mode !== 'selected' || lowCam);
      const revealed = !this.cinema || this.bayLightLevel(i) > 0;
      this.contacts[i].visible = on && this.cars.has(i) && revealed;
      if (this.cinema) {
        const car = this.cars.get(i);
        if (car) car.visible = revealed;
        const ph = this.placeholders.get(i);
        if (ph) ph.visible = false;
      }
    }
    if (this.mode === 'home' && !this.overview && !this.returning) {
      for (const [i, car] of this.cars) { const near = rowOf(i) === this.row && Math.abs(i - this.focus) <= hood; if (!near) car.visible = false; else if (!this.fades.has(i)) car.visible = true; }
      for (const [i, ph] of this.placeholders) { const near = rowOf(i) === this.row && Math.abs(i - this.focus) <= hood; if (!near) ph.visible = false; else if (!this.fades.has(i)) ph.visible = !this.cars.has(i); }
    }
    this.updateAtmosphere(now, dt);
    if (this.studioActive) {
      for (const cone of this.shafts) cone.visible = false;
      for (const smoke of this.smoke) smoke.visible = false;
      this.ovSweep.visible = false; this.ovHoverRing.visible = false;
    } else this.ovSweep.visible = this.overview && !this.cinema;
    this.renderer.render(this.scene, this.camera);
    // info resets every animation frame: read the totals for this one now
    this.lastDrawCalls = this.renderer.info.render.drawCalls;
    this.lastTriangles = this.renderer.info.render.triangles;
    if (this.firstFrameAt === null) this.firstFrameAt = performance.now();

    const pickerVisible = this.mobile && this.mode === 'home' && this.overview && !this.cinema && !this.returning;
    if (this.overviewPicker && this.overviewPicker.hidden === pickerVisible) this.overviewPicker.hidden = !pickerVisible;
    const picked = pickerVisible ? Number(this.overviewChoice.value) : -1;
    // Labels projected from world anchors; portrait overview uses bay numbers.
    if (this.mode === 'home') {
      const w = rect.width, h = rect.height;
      const v = new THREE.Vector3();
      const xs = [];
      for (let i = 0; i < this.labels.length; i++) {
        const rear = i >= this.perRow;
        if (this.overview) v.set(bayX(i), .12, carZ(i) + (rear ? -1 : 1) * (this.mobile ? -3.5 : 2.8));
        else v.set(bayX(i), 2.15, rear ? -WALL_Z - .4 : WALL_Z + .4);
        v.project(this.camera);
        const el = this.labels[i];
        const x = (v.x * .5 + .5) * w, y = (-v.y * .5 + .5) * h;
        xs[i] = x;
        const inPortraitOverview = this.mobile && this.overview;
        const onScreen = v.z < 1 && (inPortraitOverview
          ? x > 0 && x < w && y > 0 && y < h
          : x > -160 && x < w + 160) && (this.overview || rowOf(i) === this.row);
        el.style.transform = `translate(-50%,-100%) translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
        const off = !onScreen || (this.cinema && this.bayLightLevel(i) < .5);
        el.classList.toggle('is-off', off);
        // The native picker is the complete keyboard route on portrait; the
        // densely placed scene markers remain available to pointer users.
        const tabIndex = off || this.cinema || this.returning || inPortraitOverview ? -1 : 0;
        if (el.tabIndex !== tabIndex) el.tabIndex = tabIndex;
        el.classList.toggle('is-focused', i === this.focus && !this.overview);
        el.classList.toggle('is-hover', this.overview && i === this.ovHover);
        el.classList.toggle('is-picked', picked === i);
      }
      if (this.overview && !this.mobile) {
        // Fit each label to the on-screen bay spacing so long names never overlap.
        const sorted = xs.filter((x, i) => !this.labels[i].classList.contains('is-off')).sort((a, b) => a - b);
        let gap = Infinity;
        for (let i = 1; i < sorted.length; i++) gap = Math.min(gap, sorted[i] - sorted[i - 1]);
        const mw = clamp((gap === Infinity ? 170 : gap - 14), 60, 170);
        for (const el of this.labels) el.style.maxWidth = `${mw.toFixed(0)}px`;
      } else {
        for (const el of this.labels) el.style.maxWidth = '';
      }
    }

    const ms = performance.now() - t0;
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 120) this.frameTimes.shift();
    if (this.cadence.length >= 20) {
      const avg = this.cadence.reduce((a, b) => a + b, 0) / this.cadence.length;
      this.fps = Math.round(1000 / avg);
    }
    // Adaptive resolution for weak GPUs: steps only between gestures (never
    // mid-drag or mid-flight) so steering always keeps the current quality.
    if (!this.memoryConstrained && !this.drag?.moved && !this.flight && this.cadence.length >= 60 && now > this.ratioCooldown) {
      const avg = this.cadence.reduce((a, b) => a + b, 0) / this.cadence.length;
      const min = this.basePixelRatio * .75;
      let next = this.pixelRatio;
      if (avg > 16.5 && next > min) next = Math.max(min, next - .25);
      else if (avg < 12.5 && next < this.basePixelRatio) next = Math.min(this.basePixelRatio, next + .25);
      if (next !== this.pixelRatio) {
        this.pixelRatio = next; this.ratioCooldown = now + 2500; this.cadence.length = 0;
        this.renderer.setPixelRatio(next); this.resize();
      }
    }
  }
  stats() {
    const info = this.renderer.info;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    return {
      backend: this.backend,
      mode: this.mode, focus: this.focus, selected: this.selected,
      row: this.row, overview: this.overview,
      loaded: this.parked, total: this.vehicles.length, bays: this.bayCount, queued: this.queue.length,
      fps: this.fps,
      renderMsAvg: +(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)).toFixed(2),
      renderMsP95: +(sorted[Math.floor(sorted.length * .95)] || 0).toFixed(2),
      drawCalls: this.lastDrawCalls, reflectorDraws: this.reflectorDraws, triangles: this.lastTriangles,
      pixelRatio: this.pixelRatio,
      geometries: info.memory.geometries, textures: info.memory.textures, programs: info.memory.programs,
      memoryConstrained:this.memoryConstrained, canvasPixels:this.canvas.width*this.canvas.height,
      detailResident:this.detailResident?1:0,detailPending:this.pendingDetail?1:0,prefetchBuffers:this.buffers.size,
      loadTimes: this.loadTimes,
      firstFrameMs: this.firstFrameAt === null ? null : Math.round(this.firstFrameAt - this.t0),
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null
    };
  }
  dispose() {
    if (this.disposeTask) return this.disposeTask;
    this.disposed = true;
    this.inputLifetime.close();
    clearTimeout(this.dragResetTimer);
    if (this.drag && this.stage.hasPointerCapture?.(this.drag.id)) {
      try { this.stage.releasePointerCapture(this.drag.id); } catch { /* pointer ended concurrently */ }
    }
    this.drag = null;
    this.stage.classList.remove('dragging');
    this.stage.style.cursor = '';
    this.cancelDetail();this.releaseDetail();
    for (const c of this.dlControllers) c.abort();
    const downloads = [...this.buffers.values()];
    this.dlControllers.clear();
    this.buffers.clear();this.queue.length=0;this.queued.clear();
    this.controls?.dispose();
    if (this.renderer.hasInitialized()) this.renderer.setAnimationLoop(null);
    this.overviewPicker?.remove();
    this.studioCurtain?.remove();
    this.labels.forEach(label => label.remove());
    this.canvas.remove();
    // Leave the renderer and decoders alive until an already-started parse or
    // compile settles. Late holders are disposed by their owning queue's finally.
    this.disposeTask = (async () => {
      await Promise.allSettled([this.queueTask, this.detailTask, this.compileQueue, ...downloads]);
      this.ktx2?.dispose();
      for (const car of this.cars.values()) disposeModel(car);
      this.cars.clear();
      this.scene?.traverse(node => { if (node.isLight) node.shadow?.dispose?.(); });
      disposeResources(this.scene, [this.marbleFloor]);
      this.refl?.dispose?.();
      this.envTarget?.dispose();
      this.scene?.clear();
      await this.renderer.dispose().catch(() => {});
    })();
    return this.disposeTask;
  }
}

function silhouetteGeometry() {
  const s = new THREE.Shape();
  s.moveTo(-2.25, .22);
  s.lineTo(-2.28, .5);
  s.quadraticCurveTo(-1.7, .74, -.95, .8);
  s.quadraticCurveTo(-.35, 1.08, .45, 1.06);
  s.quadraticCurveTo(1.25, 1.0, 1.85, .74);
  s.quadraticCurveTo(2.28, .6, 2.28, .42);
  s.lineTo(2.25, .22);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1.86, bevelEnabled: true, bevelThickness: .1, bevelSize: .09, bevelSegments: 2, steps: 1, curveSegments: 8 });
  g.translate(0, 0, -.93);
  g.rotateY(Math.PI / 2);
  return g;
}

function roundedRing(w, h, r, thickness) {
  const shape = new THREE.Shape();
  const hw = w / 2, hh = h / 2;
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh); shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
  shape.lineTo(hw, hh - r); shape.quadraticCurveTo(hw, hh, hw - r, hh);
  shape.lineTo(-hw + r, hh); shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
  shape.lineTo(-hw, -hh + r); shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  const hole = new THREE.Path();
  const iw = hw - thickness, ih = hh - thickness, ir = Math.max(.1, r - thickness);
  hole.moveTo(-iw + ir, -ih);
  hole.lineTo(iw - ir, -ih); hole.quadraticCurveTo(iw, -ih, iw, -ih + ir);
  hole.lineTo(iw, ih - ir); hole.quadraticCurveTo(iw, ih, iw - ir, ih);
  hole.lineTo(-iw + ir, ih); hole.quadraticCurveTo(-iw, ih, -iw, ih - ir);
  hole.lineTo(-iw, -ih + ir); hole.quadraticCurveTo(-iw, -ih, -iw + ir, -ih);
  shape.holes.push(hole);
  return new THREE.ShapeGeometry(shape, 12);
}
