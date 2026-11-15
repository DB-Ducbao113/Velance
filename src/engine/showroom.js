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
    try { await showroom.init(); } catch (error) { showroom.dispose(); throw error; }
    return showroom;
  }
  constructor({ stage, labelHost, vehicles, focus = 0, reduced = false, onProgress = () => {}, onReady = () => {}, onError = () => {}, onFocus = () => {}, onSelect = () => {}, onOverview = () => {} }) {
    this.stage = stage; this.labelHost = labelHost; this.vehicles = vehicles;
    this.reduced = reduced; this.onProgress = onProgress; this.onReady = onReady;
    this.onError = onError; this.onFocus = onFocus; this.onSelect = onSelect; this.onOverview = onOverview;
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
    this.queue = []; this.queued = new Set(); this.loading = false; this.inflight = null; this.streamStarted = false;
    this.loader = new GLTFLoader(); this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.loadTimes = {}; this.t0 = performance.now(); this.firstFrameAt = null;
    this.flight = null; this.selected = null;
    this.frameTimes = []; this.cadence = []; this.fps = null; this.lastDraw = 0; this.lastNow = 0;
    this.disposed = false;
    this.compileQueue = Promise.resolve();
    this.reflectOn = true; this.reflectorDraws = 0; this.lastDrawCalls = 0; this.lastTriangles = 0;
    this.basePixelRatio = Math.min(devicePixelRatio || 1, this.mobile ? 1.5 : 2);
    this.pixelRatio = this.basePixelRatio; this.ratioCooldown = 0;
    this.reflCam = null; this.reflSkip = false; this.reflDirty = true;
    this.lastOrbitAt = 0; this.lastSize = { w: 0, h: 0, pr: 0 };
    this.texQueue = []; this.uploaded = new Set();

    this.renderer = new THREE.WebGPURenderer({
      antialias: true, alpha: false, powerPreference: 'high-performance',
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
    MeshoptDecoder.useWorkers(this.mobile ? 1 : Math.min(4, navigator.hardwareConcurrency || 2));
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
    this.env = pmrem.fromScene(room, .04).texture;
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.env;
    this.scene.environmentIntensity = .32;

    this.buildArchitecture();
    this.buildLights();
    this.buildAtmosphere();
    this.buildDetailSet();
    this.buildLabels();
    this.buildPlaceholders();

    this.raycaster = new THREE.Raycaster();
    this.bindInput();
    this.resize();
    this.applyHomeCamera();
    this.prioritize(this.focus);
    await this.warmScene().catch(error => console.warn('[VÉLANCE] pipeline warm-up failed:', error));
    if (this.disposed) return;
    this.refreshShadow();
    this.frame = this.frame.bind(this);
    this.renderer.setAnimationLoop(this.frame);
  }

  /* ---------------------------------------------------------- architecture */
  buildArchitecture() {
    const S = this.scene;
    const marbleFloor = marbleTexture('#171c21', 'rgba(210,220,230,.5)', [10, 3]);
    const marbleWall = marbleTexture('#1b2126', 'rgba(214,224,234,.55)', [1.6, 1]);
    const bronze = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: .42, metalness: .85 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: .5, metalness: .6 });
    const led = new THREE.MeshStandardMaterial({ color: 0x1a1208, emissive: 0xffc287, emissiveIntensity: 2.6, roughness: .4 });

    // Polished floor: a real planar reflection under a marble veil, mixed in
    // display space exactly as the WebGL build layered them, in one opaque draw.
    let floorMat;
    if (!this.mobile) {
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

    const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(HALL_W, HALL_DEPTH), floorDecal(new THREE.ShadowMaterial({ opacity: SHADOW_OPACITY })));
    shadowCatcher.rotation.x = -Math.PI / 2; shadowCatcher.position.set(0, .004, 0);
    shadowCatcher.receiveShadow = true; shadowCatcher.renderOrder = 2;
    S.add(shadowCatcher);

    // Two facing walls of the rectangle: one marble panel per bay + wall-wash.
    // The south group hides in overview so the aerial camera sees the rear row.
    this.washes = [];
    this.southGroup = new THREE.Group();
    S.add(this.southGroup);
    const washTex = washTexture();
    for (let i = 0; i < this.bayCount; i++) {
      const rear = i >= 8;
      const wz = rear ? -WALL_Z : WALL_Z;
      const inward = rear ? -1 : 1;
      const parent = rear ? this.southGroup : S;
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
    }
    for (const rear of [false, true]) {
      const wz = rear ? -WALL_Z : WALL_Z;
      const inward = rear ? -1 : 1;
      const parent = rear ? this.southGroup : S;
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
    for (const sx of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(HALL_DEPTH - .8, CEIL_Y), sideMat);
      wall.rotation.y = sx * -Math.PI / 2; wall.position.set(sx * HALL_W / 2, CEIL_Y / 2, 0);
      S.add(wall);
      for (let k = 0; k < 4; k++) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(.03, 4.4, .05), led);
        strip.position.set(sx * (HALL_W / 2 - .05), 2.4, -5.6 + k * 4.2);
        S.add(strip);
      }
    }
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.2), new THREE.MeshBasicMaterial({ map: textTexture('VÉLANCE', { size: 512, font: '500 92px Georgia, serif', metallic: true }), transparent: true, depthWrite: false }));
    sign.rotation.y = Math.PI / 2; sign.position.set(-HALL_W / 2 + .06, 2.6, 0); S.add(sign);

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

    // Bay markings, wheel stops, floor numbers, contact shadows, light pools.
    const lineMat = floorDecal(new THREE.MeshBasicMaterial({ color: 0xe8eef2, opacity: .75 * K_LINE }));
    const poolTex = radialTexture('rgba(255,205,150,.5)', 'rgba(255,190,120,0)');
    // Darkening also happens before tone mapping now: lift the alpha curve.
    const contactTex = radialTexture('rgba(0,0,0,.5)', 'rgba(0,0,0,0)', a => 1 - Math.pow(1 - a, 2.2));
    this.pools = []; this.contacts = [];
    for (let i = 0; i < this.bayCount; i++) {
      const rear = i >= 8;
      const cz = carZ(i);
      const inward = rear ? -1 : 1;
      const wz = rear ? -WALL_Z : WALL_Z;
      for (const sx of [-1, 1]) {
        const line = new THREE.Mesh(new THREE.PlaneGeometry(.07, 5.9), lineMat);
        line.rotation.x = -Math.PI / 2; line.position.set(bayX(i) + sx * (BAY_W / 2 - .12), .006, cz + inward * .35);
        line.renderOrder = 4; S.add(line);
      }
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
    this.scene.add(new THREE.HemisphereLight(0xf3e6d0, 0x2c343c, .5));
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
    const fill = new THREE.DirectionalLight(0xbccddd, .35);
    fill.position.set(4, 6, 8); this.scene.add(fill);
    // Overview trades the bay spots for two directionals: the aerial map view
    // stays cheap enough to pan at full frame rate.
    const oKey = new THREE.DirectionalLight(0xffe0b0, 0); oKey.position.set(6, 14, 8); oKey.userData.on = 2.4;
    const oFill = new THREE.DirectionalLight(0xbccddd, 0); oFill.position.set(-8, 10, -6); oFill.userData.on = .9;
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
    const on = !this.overview;
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
      const focused = i === this.focus && this.mode === 'home' && on;
      const target = K_ADD * (!on ? 0 : this.mode === 'selected' ? (i === this.selected ? .22 : .05) : focused ? .26 : .1);
      cone.material.opacity += (target - cone.material.opacity) * Math.min(1, dt * 4);
      cone.visible = on && cone.material.opacity > .01 * K_ADD;
    }
    this.motes.visible = on && this.mode === 'home';
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
    // Counter orbit-yaw parallax per element so the halo rings the car and the
    // wordmark sits centred above it, clear of the wall pillars. Rear row mirrors
    // the dressing depth so it stays behind the machine from the rear camera.
    const sz = index < this.perRow ? 1 : -1;
    for (const c of this.detailSet.children) c.position.z = (c.userData.bz || 0) * sz;
    const t = Math.tan(this.mobile ? 1.05 : .62);
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
      const hidden = [this.detailSet, ...this.contacts].filter(o => !o.visible);
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
      el.innerHTML = `<span class="bay-label-no">BAY ${String(i + 1).padStart(2, '0')}</span><strong>${v.make} <em>${v.name}</em></strong><span class="bay-label-tag">${v.tag}</span><span class="bay-label-cta">VIEW THIS MACHINE ↗</span>`;
      el.addEventListener('click', () => {
        if (performance.now() < this.suppressUntil || this.dragged) return;
        if (this.mode !== 'home') return;
        this.setFocus(i); this.onSelect(i);
      });
      this.labelHost.appendChild(el);
      this.labels.push(el);
    }
  }

  /* ------------------------------------------------------------- loading */
  /* Progressive: the focused bay loads first; the rest stream in one at a
   * time with idle gaps so first paint and interaction never wait on 8 GLBs. */
  prioritize(index) {
    index %= this.vehicles.length;
    if (this.cars.has(index) || this.disposed) return;
    this.queue = this.queue.filter(i => i !== index);
    this.queue.unshift(index); this.queued.add(index);
    if (this.inflight && this.inflight.index !== index) this.inflight.controller.abort();
    this.runQueue();
  }
  sortQueue() { const col = this.focus % this.vehicles.length; this.queue.sort((a, b) => Math.abs(a - col) - Math.abs(b - col)); }
  requeue(index) { if (!this.cars.has(index) && !this.queued.has(index)) { this.queue.push(index); this.queued.add(index); this.sortQueue(); } }
  enqueueAround(center) {
    center %= this.vehicles.length;
    const order = [...this.vehicles.keys()].sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    for (const i of order) if (!this.cars.has(i) && !this.queued.has(i) && this.inflight?.index !== i) { this.queue.push(i); this.queued.add(i); }
    this.runQueue();
  }
  async runQueue() {
    if (this.loading || this.disposed) return;
    this.loading = true;
    try {
      while (this.queue.length) {
        if (this.streamStarted) await new Promise(r => setTimeout(r, this.mobile ? 150 : 120));
        if (this.disposed || !this.queue.length) return;
        const index = this.queue.shift(); this.queued.delete(index);
        if (this.cars.has(index)) continue;
        const vehicle = this.vehicles[index];
        const controller = new AbortController(); this.inflight = { index, controller };
        const started = performance.now();
        try {
          const url = new URL(`./assets/models/${encodeURIComponent(vehicle.file)}`, location.href);
          const res = await fetch(url, { signal: controller.signal, cache: 'force-cache' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buffer = await res.arrayBuffer();
          if (controller.signal.aborted) { this.requeue(index); continue; }
          const gltf = await new Promise((ok, no) => this.loader.parse(buffer, new URL('./assets/models/', location.href).href, ok, no));
          if (this.disposed) return;
          const holder = normalise(gltf.scene, vehicle);
          holder.rotation.y += .3 + (index >= this.perRow ? Math.PI : 0) + (NOSE_BACK.has(vehicle.id) ? Math.PI : 0);
          holder.position.set(bayX(index), 0, carZ(index));
          this.finishMaterials(holder);
          this.collectPaint(holder);
          const choice = this.paintChoice.get(index);
          if (choice) this.applyPaint(holder, choice);
          const casts = this.mode === 'selected' && index === this.selected;
          holder.traverse(n => { if (n.isMesh) n.castShadow = casts; });
          holder.userData.index = index;
          holder.userData.triangles = 0;
          holder.traverse(n => { if (n.isMesh) holder.userData.triangles += (n.geometry.index?.count ?? n.geometry.attributes.position.count) / 3; });
          // Never compile a new machine mid-drag: the pipeline build would
          // hitch the very motion the visitor is steering.
          while (!this.disposed && this.drag?.moved) await new Promise(r => setTimeout(r, 80));
          if (this.disposed) return;
          await this.compile(holder, () => cullOff(holder)).catch(error => console.warn('[VÉLANCE] compile', vehicle.id, error));
          if (this.disposed) return;
          if (this.mode === 'selected' && index !== this.selected) { this.setCarAlpha(holder, 0); holder.visible = false; }
          holder.traverse(n => { if (n.isMesh) n.castShadow = this.mode === 'selected' && index === this.selected; });
          this.scene.add(holder);
          this.cars.set(index, holder);
          // Home culling never renders distant cars, so their textures would
          // all lazy-upload in one stall the first time overview reveals them.
          holder.traverse(n => {
            if (!n.isMesh) return;
            for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
              if (!m) continue;
              for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap']) {
                const t = m[key];
                if (t && !this.uploaded.has(t)) { this.uploaded.add(t); this.texQueue.push(t); }
              }
            }
          });
          this.parked++;
          this.contacts[index].visible = true;
          const ph = this.placeholders.get(index);
          if (ph) ph.userData.dying = true;
          this.refreshShadow();
          this.loadTimes[vehicle.id] = Math.round(performance.now() - started);
          this.labels[index].classList.add('is-loaded');
          this.onProgress(this.parked, this.vehicles.length, index);
          if (this.parked === 1 && !this.streamStarted) { this.streamStarted = true; this.enqueueAround(this.focus); }
          if (this.parked === this.vehicles.length) this.onReady();
        } catch (err) {
          if (err?.name === 'AbortError') this.requeue(index);
          else { this.labels[index].classList.add('is-error'); this.onError(index, err.message || String(err)); }
        } finally { if (this.inflight?.index === index) this.inflight = null; }
      }
    } finally {
      this.loading = false;
      if (this.queue.length) queueMicrotask(() => this.runQueue());
    }
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
    for (const m of u.fadeMats) m.opacity = m.userData.baseOpacity * alpha;
    const order = alpha < .999 ? 10 : 0;
    for (const n of u.opaqueMeshes) n.renderOrder = order;
    for (const n of u.cutoutMeshes) n.visible = alpha > .5;
  }
  tuneMaterial(mat) {
    const name = (mat.name || '').toLowerCase();
    if (/glass|window|light|lamp|emissive|tyre|tire|rubber|tread/.test(name) || mat.transmission > 0 || mat.opacity < .99) {
      mat.envMapIntensity = /glass|window/.test(name) ? 1.15 : .8;
      return mat;
    }
    const paint = /paint|carpaint|body_color|coloured|_spec_|siny/.test(name) || (!mat.map && mat.roughness <= .28);
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
      m.clearcoatRoughness = .06;
      m.envMapIntensity = 1.3;
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
    const converted = new Map(paint.map(m => [m, createCarPaintMaterial(m, { coordinateScale: holder.scale.x })]));
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
    stage.addEventListener('pointerdown', e => {
      if (this.mode !== 'home' || e.button !== 0) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, initial: this.position, base: Math.round(this.position), initialPan: this.ovPan, moved: false, lastVal: this.overview ? this.ovPan : this.position, lastT: performance.now(), vel: 0 };
      this.dragged = false; stage.style.cursor = '';
    });
    stage.addEventListener('pointermove', e => {
      const p = this.drag;
      if (!p || p.id !== e.pointerId || this.mode !== 'home') return;
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
      else { const [lo, hi] = this.rowBounds(); this.setFocus(clamp(Math.round(this.position), lo, hi)); }
      setTimeout(() => { this.dragged = false; }, 40);
    };
    stage.addEventListener('pointerup', e => {
      const wasDrag = this.drag?.moved;
      end(e);
      if (!wasDrag && this.mode === 'home' && performance.now() > this.suppressUntil) {
        const hit = this.pickCar(e.clientX, e.clientY);
        if (hit !== null) { this.setFocus(hit); this.onSelect(hit); }
      }
    });
    stage.addEventListener('pointercancel', end);
    // Overview hover: cheap floor-plane pick (no per-mesh raycast) lights a ring
    // under the pointed bay and glows its label.
    stage.addEventListener('pointermove', e => {
      if (this.mode !== 'home' || !this.overview || this.drag?.moved) return;
      this.ovHover = this.pickBay(e.clientX, e.clientY);
      stage.style.cursor = this.ovHover !== null ? 'pointer' : '';
    });
    stage.addEventListener('pointerleave', () => { this.ovHover = null; stage.style.cursor = ''; });
    stage.addEventListener('dragstart', e => e.preventDefault());
    stage.addEventListener('wheel', e => {
      if (this.mode !== 'home' || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (this.overview) { this.ovTarget = clamp(this.ovTarget + (e.deltaX > 0 ? 2.5 : -2.5), -this.ovLimit, this.ovLimit); return; }
      // Touchpad: one car per swipe, then a short lock so it cannot chain.
      const now = performance.now();
      if (now < (this.wheelLock || 0)) return;
      this.wheelLock = now + 420;
      if (e.deltaX > 0) this.next(); else this.prev();
    }, { passive: false });
    addEventListener('resize', () => this.resize(), { passive: true });
  }
  /* Screen-right / screen-left: the rear row faces the other way, so its
   * index order runs opposite to the front row on screen. */
  next() { const [lo] = this.rowBounds(); const step = this.row === 1 ? -1 : 1; this.setFocus(lo + ((this.focus - lo + step + this.perRow) % this.perRow)); }
  prev() { const [lo] = this.rowBounds(); const step = this.row === 1 ? 1 : -1; this.setFocus(lo + ((this.focus - lo + step + this.perRow) % this.perRow)); }
  pickCar(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const groups = [...this.cars.values(), ...this.placeholders.values()];
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
    const [lo, hi] = this.rowBounds(rowOf(clamp(i, 0, this.bayCount - 1)));
    const next = clamp(i, lo, hi);
    this.target = next;
    this.row = rowOf(next);
    if (next !== this.focus) { this.focus = next; if (!silent) this.onFocus(next); }
    if (this.reduced) this.position = next;
    this.sortQueue();
    this.runQueue();
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
    this.flight = { t: 0, start: performance.now(), dur: this.reduced ? 0 : .6, fromPos: this.camera.position.clone(), fromLook: this.currentLook(), toPos: pos, toLook: look, done: null };
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
  overviewPose() {
    const aspect = this.camera.aspect || 1;
    const vFov = this.camera.fov * Math.PI / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const halfW = HALL_W / 2 + 2;
    if (this.mobile) {
      // Portrait: look down the long axis so the whole rectangle fits.
      const dist = clamp(Math.max((HALL_W / 2 + 2) / Math.tan(vFov / 2), (HALL_DEPTH / 2 + 2) / Math.tan(hFov / 2)) * 1.08, 26, 62);
      this.ovLimit = Math.max(2, HALL_DEPTH / 2 + 2 - Math.tan(hFov / 2) * dist * .92);
      return { pos: new THREE.Vector3(-dist * .62, dist * .78, this.ovPan), look: new THREE.Vector3(-.4, -1.5, this.ovPan) };
    }
    const dist = clamp(Math.max(halfW / Math.tan(hFov / 2), 12 / Math.tan(vFov / 2)), 26, 46);
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
  applyOverviewState(on) {
    this.overview = on;
    this.stage.classList.toggle('is-overview', on);
    if (on) this.ovOpenAt = performance.now(); else this.ovHover = null;
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
    this.resize();
    this.reflDirty = true;
    if (!on) { this.ovPan = 0; this.ovTarget = 0; }
    this.onOverview(on);
  }
  toggleOverview() {
    if (this.mode !== 'home') return;
    const on = !this.overview;
    this.applyOverviewState(on);
    const to = on ? this.overviewPose() : this.homePose(this.position);
    this.flight = { t: 0, start: performance.now(), dur: this.reduced ? 0 : .7, fromPos: this.camera.position.clone(), fromLook: this.currentLook(), toPos: to.pos, toLook: to.look, done: null };
  }
  select(index, hostEl) {
    if (this.mode !== 'home') return;
    if (this.overview) this.applyOverviewState(false);
    if (this.refl) { this.reflectOn = false; this.uReflect.value = 0; }
    this.mode = 'selected'; this.selected = index; this.row = rowOf(index);
    this.prioritize(index);
    this.stage.classList.add('is-selected');
    for (const [i] of this.cars) if (i !== index) this.fades.set(i, { from: 1, to: 0, start: performance.now() });
    for (const [i, ph] of this.placeholders) ph.visible = i === index;
    const center = new THREE.Vector3(bayX(index), .78, carZ(index));
    const yaw = this.mobile ? 1.05 : .62, dist = this.mobile ? 9.6 : 6.6;
    this.detailHost = hostEl;
    const sz = index < this.perRow ? 1 : -1;
    // Mirror the approach side on the rear row so the nose always reads left,
    // matching the front row (the rear camera faces +Z).
    const endPos = center.clone().add(new THREE.Vector3(Math.sin(yaw) * dist * sz, 1.42, Math.cos(yaw) * dist * sz));
    this.controls = new OrbitControls(this.camera, hostEl);
    this.controls.enabled = false;
    this.controls.addEventListener('change', () => { this.lastOrbitAt = performance.now(); });
    this.controls.enableDamping = true; this.controls.dampingFactor = .07;
    this.controls.enablePan = false; this.controls.enableZoom = false;
    this.controls.rotateSpeed = .55;
    this.controls.minDistance = 4.4; this.controls.maxDistance = 10.5;
    this.controls.minPolarAngle = .32; this.controls.maxPolarAngle = 1.46;
    hostEl.style.touchAction = 'none';
    this.flight = {
      t: 0, start: performance.now(), dur: this.reduced ? 0 : .62,
      fromPos: this.camera.position.clone(), fromLook: this.currentLook(),
      toPos: endPos, toLook: center,
      done: () => {
        this.reflectOn = true;
        this.reflDirty = true;
        this.refreshShadow();
        this.controls.target.copy(center);
        this.controls.enabled = true;
        this.controls.update();
        this.frameViewOffset();
      }
    };
    const car = this.cars.get(index);
    if (car) car.traverse(n => { if (n.isMesh) n.castShadow = true; });
    this.keyShadow.position.set(bayX(index) + 2.5 * sz, CEIL_Y - .3, index < this.perRow ? -2.4 : 2.4);
    this.keyShadow.target.position.copy(center);
    this.keyShadow.intensity = 240;
    this.placeDetailSet(index);
  }
  frameViewOffset() {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (this.mobile) {
      // Fit the car's projected span to the detail host width, then centre the
      // look-at point in that host instead of the full-height stage.
      const sr = this.stage.getBoundingClientRect();
      const hr = this.detailHost ? this.detailHost.getBoundingClientRect() : null;
      const hostW = hr && hr.width > 40 ? hr.width : w * .9;
      const centerY = hr ? hr.top - sr.top + hr.height / 2 : h * .29;
      const fullH = 2 * 9.6 * Math.tan(this.camera.fov * Math.PI / 360) * hostW / 4.6;
      this.camera.setViewOffset(w, fullH, 0, fullH / 2 - centerY, w, h);
    } else this.camera.setViewOffset(w * 1.42, h, w * .42, 0, w, h);
    this.camera.updateProjectionMatrix();
  }
  clearSelection() {
    if (this.mode !== 'selected') return;
    const index = this.selected;
    const look = this.controls ? this.controls.target.clone() : this.currentLook();
    this.controls?.dispose(); this.controls = null;
    this.mode = 'home'; this.selected = null;
    if (this.detailSet) this.detailSet.visible = false;
    this.ceilGroup.visible = true;
    this.camera.clearViewOffset(); this.camera.updateProjectionMatrix();
    this.stage.classList.remove('is-selected');
    for (const [i] of this.cars) if (i !== index) this.fades.set(i, { from: 0, to: 1, start: performance.now() });
    for (const [, ph] of this.placeholders) ph.visible = true;
    const car = this.cars.get(index);
    if (car) car.traverse(n => { if (n.isMesh) n.castShadow = false; });
    this.keyShadow.intensity = 0;
    this.reflectOn = true;
    this.refreshShadow();
    const { pos, look: homeLook } = this.homePose(this.position);
    this.flight = { t: 0, start: performance.now(), dur: this.reduced ? 0 : .55, fromPos: this.camera.position.clone(), fromLook: look, toPos: pos, toLook: homeLook, done: null };
  }
  currentLook() {
    const dir = new THREE.Vector3(); this.camera.getWorldDirection(dir);
    return this.camera.position.clone().add(dir.multiplyScalar(10));
  }
  /* Cinematic entrance: crane down from the ceiling onto the focused machine. */
  entrance() {
    if (this.mode !== 'home' || this.overview || this.flight) return;
    const { pos, look } = this.homePose(this.position);
    const center = new THREE.Vector3(bayX(this.position), .8, carZ(this.position));
    const fromPos = new THREE.Vector3(center.x + .4, CEIL_Y - .45, center.z + .4);
    // The mirror pass is the heaviest GPU cost; drop it for the crane and fade
    // it back once the camera lands, keeping headroom for streaming uploads.
    if (this.refl && this.backend === 'webgpu') { this.reflectOn = false; this.uReflect.value = 0; }
    this.flight = { t: 0, start: performance.now(), dur: this.reduced ? 0 : 1.9, cinema: true, fromPos, fromLook: center, toPos: pos, toLook: look, done: () => { this.reflectOn = true; this.reflDirty = true; } };
  }
  resetView() {
    if (this.mode !== 'selected') return;
    const center = this.controls.target.clone();
    const yaw = this.mobile ? 1.05 : .62, dist = this.mobile ? 10.2 : 7.4;
    const sz = this.selected < this.perRow ? 1 : -1;
    this.camera.position.copy(center).add(new THREE.Vector3(Math.sin(yaw) * dist * sz, 1.55, Math.cos(yaw) * dist * sz));
    this.controls.update();
  }
  resize() {
    const w = Math.max(1, this.stage.clientWidth), h = Math.max(1, this.stage.clientHeight);
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
    if (this.mode === 'selected') this.frameViewOffset();
    else if (this.overview && !this.flight) this.applyOverviewCamera();
  }

  /* ---------------------------------------------------------------- loop */
  frame(now) {
    if (this.disposed || document.hidden) return;
    const rect = this.stage.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= innerHeight) return;
    const settling = this.mode === 'home' && !this.flight && (this.overview ? Math.abs(this.ovTarget - this.ovPan) > .001 : Math.abs(this.target - this.position) > .002);
    const orbitActive = !!this.controls?.enabled && now - this.lastOrbitAt < 160;
    const interacting = !!this.drag?.moved || !!this.flight || orbitActive || settling || this.fades.size > 0;
    const idleInterval = this.mobile ? 1000 / 24 : 1000 / 30;
    // Trickle one texture upload per idle frame so first reveal of a culled
    // machine never pays a bulk GPU upload; gestures always preempt it.
    if (!interacting && this.texQueue.length) this.renderer.initTexture?.(this.texQueue.shift());
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
        if (Math.abs(d) > .001) this.ovPan += d * (1 - Math.exp(-dt / .14));
        this.applyOverviewCamera();
      } else {
        // While dragging, the camera follows the finger directly (no snap-fight);
        // on release it eases toward the momentum target.
        if (!this.drag?.moved) {
          const diff = this.target - this.position;
          if (Math.abs(diff) > .0005) {
            this.position += diff * (1 - Math.exp(-dt / .16));
            if (Math.abs(this.target - this.position) < .002) this.position = this.target;
            const [lo, hi] = this.rowBounds();
            this.focus = clamp(Math.round(this.position), lo, hi);
          }
        }
        this.applyHomeCamera();
      }
    }
    // camera flight (wall-clock so heavy frames never slow the choreography)
    if (this.flight) {
      const f = this.flight;
      f.t = f.dur === 0 ? 1 : Math.min(1, (now - f.start) / (f.dur * 1000));
      const k = easeInOut(f.t);
      this.camera.position.lerpVectors(f.fromPos, f.toPos, k);
      const look = new THREE.Vector3().lerpVectors(f.fromLook, f.toLook, k);
      this.camera.lookAt(look);
      if (f.t >= 1) { this.flight = null; this.cadence.length = 0; f.done?.(); }
    }
    if (this.controls?.enabled) this.controls.update();

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
    for (const spot of this.spots) {
      const i = spot.userData.bay ?? litRow * this.perRow;
      const focused = i === this.focus && this.mode === 'home' && !this.overview;
      const base = this.mode === 'selected' ? (i === this.selected ? 200 : 26) : this.overview ? 0 : (focused ? 250 : 95);
      spot.intensity += (base * (1 + (focused ? breathe : 0)) - spot.intensity) * ease;
      spot.position.lerp(spot.userData.gp, ease);
      spot.target.position.lerp(spot.userData.gt, ease);
    }
    // Overview: a slow champagne band crosses the floor; each bay brightens as
    // it passes, bays cascade alight on open, and the hovered bay gets a ring.
    if (this.overview) {
      this.ovSweepX = ((now / 1000 * 3.2) % (HALL_W + 10)) - HALL_W / 2 - 5;
      this.ovSweep.position.x = this.ovSweepX;
      this.ovSweep.material.opacity += (.12 * K_ADD - this.ovSweep.material.opacity) * ease;
    }
    for (let i = 0; i < this.bayCount; i++) {
      const focused = i === this.focus && this.mode === 'home' && !this.overview;
      let washTarget = K_ADD * (this.overview ? .5 : focused ? .8 : .38);
      let poolTarget = K_ADD * (this.overview ? .3 : focused ? .5 : .22);
      if (this.overview) {
        const reveal = this.reduced ? 1 : easeInOut(clamp((now - this.ovOpenAt - i * 45) / 600, 0, 1));
        const d = bayX(i) - this.ovSweepX;
        const pulse = Math.exp(-(d * d) / 24);
        const hov = i === this.ovHover ? .22 : 0;
        washTarget = K_ADD * (.5 + .35 * pulse + hov) * reveal;
        poolTarget = K_ADD * (.3 + .4 * pulse + hov) * reveal;
      }
      this.washes[i].material.opacity += (washTarget - this.washes[i].material.opacity) * ease;
      this.pools[i].material.opacity += (poolTarget - this.pools[i].material.opacity) * ease;
    }
    if (this.ovHoverRing) {
      const on = this.overview && this.ovHover !== null;
      if (on) this.ovHoverRing.position.set(bayX(this.ovHover), .02, carZ(this.ovHover));
      const target = on ? .5 * K_ADD : 0;
      this.ovHoverRing.material.opacity += (target - this.ovHoverRing.material.opacity) * ease;
      this.ovHoverRing.visible = this.ovHoverRing.material.opacity > .01 * K_ADD;
    }
    for (const light of this.overviewLights) light.intensity += ((this.overview ? light.userData.on : 0) - light.intensity) * ease;
    if (this.refl) this.uReflect.value += ((this.reflectOn ? 1 : 0) - this.uReflect.value) * Math.min(1, dt * 6);

    // Home only renders the focused neighbourhood; distant machines stay culled.
    // Transparent dressing (washes, pools, shafts, contacts) is culled with them
    // so mobile never pays full-hall additive overdraw.
    const hood = this.mobile ? 1 : 2;
    const lowCam = this.camera.position.y < CEIL_Y - .5;
    if (this.mode === 'selected') this.ceilGroup.visible = lowCam;
    for (let i = 0; i < this.bayCount; i++) {
      const on = this.overview ? true : this.mode === 'selected' ? i === this.selected : Math.abs(i - this.focus) <= hood;
      this.washes[i].visible = on;
      this.pools[i].visible = on;
      this.shafts[i].visible = on && (this.mode !== 'selected' || lowCam);
      this.contacts[i].visible = on && this.cars.has(i);
    }
    if (this.mode === 'home' && !this.overview) {
      for (const [i, car] of this.cars) { const near = Math.abs(i - this.focus) <= hood; if (!near) car.visible = false; else if (!this.fades.has(i)) car.visible = true; }
      for (const [i, ph] of this.placeholders) { const near = Math.abs(i - this.focus) <= hood; if (!near) ph.visible = false; else if (!this.fades.has(i)) ph.visible = true; }
    }
    this.updateAtmosphere(now, dt);
    this.renderer.render(this.scene, this.camera);
    // info resets every animation frame: read the totals for this one now
    this.lastDrawCalls = this.renderer.info.render.drawCalls;
    this.lastTriangles = this.renderer.info.render.triangles;
    if (this.firstFrameAt === null) this.firstFrameAt = performance.now();

    // labels projected from world anchors (front row only; rear bays stay empty)
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
        const onScreen = v.z < 1 && x > -160 && x < w + 160 && (this.overview || rowOf(i) === this.row);
        el.style.transform = `translate(-50%,-100%) translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
        el.classList.toggle('is-off', !onScreen);
        el.classList.toggle('is-focused', i === this.focus && !this.overview);
        el.classList.toggle('is-hover', this.overview && i === this.ovHover);
      }
      if (this.overview) {
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
    if (!this.drag?.moved && !this.flight && this.cadence.length >= 60 && now > this.ratioCooldown) {
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
      loadTimes: this.loadTimes,
      firstFrameMs: this.firstFrameAt === null ? null : Math.round(this.firstFrameAt - this.t0),
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null
    };
  }
  dispose() {
    this.disposed = true;
    this.inflight?.controller.abort();
    this.controls?.dispose();
    this.ktx2?.dispose();
    if (this.renderer.hasInitialized()) this.renderer.setAnimationLoop(null);
    this.renderer.dispose().catch(() => {});
    this.canvas.remove();
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
