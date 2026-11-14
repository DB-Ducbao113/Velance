/**
 * VÉLANCE V9 — the showroom is one real perspective WebGL scene.
 * Architecture (floor, walls, columns, slatted ceiling, LED coves) is modeled
 * in meters; eight native GLBs park wheels-on-floor in marked bays.
 * Home: entrance camera, horizontal drag pans the hall with eased snapping.
 * Selected: other machines fade out, camera flies in, orbit + zoom on the left.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BAY_W = 6.4;
const CAR_LEN = 4.6;
const CAR_Z = -5.3;
const WALL_Z = -8.0;
const HALL_DEPTH = 17.2;
const CEIL_Y = 5.35;
const bayX = i => ((i % 8) - 3.5) * BAY_W;
const rowOf = i => (i < 8 ? 0 : 1);
const carZ = i => (i < 8 ? CAR_Z : -CAR_Z);
const NOSE_BACK = new Set(['mclarenp1']);
const HALL_W = 8 * BAY_W + 5;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeInOut = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

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
function radialTexture(inner, outer) {
  return canvasTexture(256, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, s * .04, s / 2, s / 2, s / 2);
    g.addColorStop(0, inner); g.addColorStop(1, outer);
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
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

/* Merge a loaded GLB into one mesh per material: ~1200 draw calls become ~30. */
/* Quantized (normalized integer) attributes must become float before baking
 * node transforms: applyMatrix4/setXYZ do not re-normalize integer arrays. */
function dequantize(g) {
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name];
    if (!a.normalized || a.array instanceof Float32Array) continue;
    const arr = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) {
      arr[i * a.itemSize] = a.getX(i);
      if (a.itemSize > 1) arr[i * a.itemSize + 1] = a.getY(i);
      if (a.itemSize > 2) arr[i * a.itemSize + 2] = a.getZ(i);
      if (a.itemSize > 3) arr[i * a.itemSize + 3] = a.getW(i);
    }
    g.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, false));
  }
  return g;
}
/* Skinned GLBs (McLaren P1) pose vertices on the GPU; merging must bake the
 * same skin matrix per vertex first, in local space, or parts fly apart. */
function bakeSkin(node, g) {
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  if (!si || !sw || !node.skeleton) return;
  node.skeleton.update();
  const bm = node.skeleton.boneMatrices;
  const pos = g.attributes.position, nor = g.attributes.normal, tan = g.attributes.tangent;
  const acc = new Float32Array(16);
  const full = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3();
  const base = node.bindMatrixInverse, bind = node.bindMatrix;
  for (let i = 0; i < pos.count; i++) {
    acc.fill(0);
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (!w) continue;
      const o = si.getComponent(i, k) * 16;
      for (let e = 0; e < 16; e++) acc[e] += w * bm[o + e];
    }
    full.fromArray(acc).premultiply(base).multiply(bind);
    v.fromBufferAttribute(pos, i).applyMatrix4(full);
    pos.setXYZ(i, v.x, v.y, v.z);
    nm.getNormalMatrix(full);
    if (nor) { v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); nor.setXYZ(i, v.x, v.y, v.z); }
    if (tan) { v.fromBufferAttribute(tan, i).applyMatrix3(nm).normalize(); tan.setXYZ(i, v.x, v.y, v.z); }
  }
  g.deleteAttribute('skinIndex');
  g.deleteAttribute('skinWeight');
}
function compactCar(root) {
  root.updateMatrixWorld(true);
  const buckets = new Map();
  const originals = [];
  root.traverse(node => {
    if (!node.isMesh) return;
    originals.push(node);
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    const geo = node.geometry;
    if (!geo?.attributes?.position) return;
    mats.forEach((mat, mi) => {
      if (!mat) return;
      const g = geo.clone();
      dequantize(g);
      if (node.isSkinnedMesh) bakeSkin(node, g);
      if (Array.isArray(node.material)) {
        const group = geo.groups.find(gr => gr.materialIndex === mi);
        if (!group) return;
        const src = g.index ? g.toNonIndexed() : g;
        const ng = new THREE.BufferGeometry();
        for (const name of Object.keys(src.attributes)) {
          const attr = src.attributes[name];
          ng.setAttribute(name, new THREE.BufferAttribute(
            attr.array.slice(group.start * attr.itemSize, (group.start + group.count) * attr.itemSize), attr.itemSize, attr.normalized));
        }
        g.dispose(); if (src !== g) src.dispose();
        applyMatrix(ng, node.matrixWorld);
        pushBucket(buckets, mat, ng);
        return;
      }
      applyMatrix(g, node.matrixWorld);
      pushBucket(buckets, mat, g);
    });
  });
  function applyMatrix(g, m) { g.applyMatrix4(m); }
  function pushBucket(map, mat, g) {
    // static display models: drop unused morph targets so merges stay consistent
    g.morphAttributes = {};
    g.morphTargetsRelative = false;
    // mergeGeometries requires identical attribute types/normalization/index
    // types; quantized GLBs mix float and normalized-short UVs per material.
    const sig = Object.keys(g.attributes).sort().map(n => {
      const a = g.attributes[n];
      return `${n}:${a.array.constructor.name}:${a.itemSize}:${a.normalized ? 1 : 0}`;
    }).join(',') + (g.index ? `|i:${g.index.array.constructor.name}` : '|n');
    const key = mat.uuid + '|' + sig;
    if (!map.has(key)) map.set(key, { mat, geos: [] });
    map.get(key).geos.push(g);
  }
  const group = new THREE.Group();
  let triangles = 0;
  for (const { mat, geos } of buckets.values()) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!merged) continue;
    if (geos.length > 1) geos.forEach(g => g.dispose());
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    triangles += Math.floor((merged.index ? merged.index.count : merged.attributes.position.count) / 3);
    group.add(mesh);
  }
  const disposed = new Set();
  originals.forEach(node => {
    if (!disposed.has(node.geometry)) { node.geometry.dispose(); disposed.add(node.geometry); }
  });
  group.userData.triangles = triangles;
  return group;
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
  constructor({ stage, labelHost, vehicles, focus = 0, reduced = false, onProgress = () => {}, onReady = () => {}, onError = () => {}, onFocus = () => {}, onSelect = () => {}, onOverview = () => {} }) {
    this.stage = stage; this.labelHost = labelHost; this.vehicles = vehicles;
    this.reduced = reduced; this.onProgress = onProgress; this.onReady = onReady;
    this.onError = onError; this.onFocus = onFocus; this.onSelect = onSelect; this.onOverview = onOverview;
    this.mobile = matchMedia('(max-width:620px)').matches;
    this.mode = 'home';
    this.bayCount = vehicles.length * 2;
    // Only the front row holds real machines; the rear row stays empty (marked
    // bays awaiting future models). Home browsing is limited to the front row.
    this.homeCount = vehicles.length;
    this.row = rowOf(focus); this.overview = false; this.ovPan = 0; this.ovTarget = 0; this.ovLimit = 8;
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

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, this.mobile ? 1.5 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.setClearColor(0x05070a, 1);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'garage-canvas';
    stage.prepend(this.canvas);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05070a, .0135);
    this.camera = new THREE.PerspectiveCamera(this.mobile ? 60 : 50, 1, .1, 120);
    this.scene.add(this.camera);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.env = pmrem.fromScene(new RoomEnvironment(), .04).texture;
    this.scene.environment = this.env;
    this.scene.environmentIntensity = .32;
    pmrem.dispose();

    this.buildArchitecture();
    this.buildLights();
    this.buildAtmosphere();
    this.buildDetailSet();
    this.buildLabels();
    this.buildPlaceholders();

    this.raycaster = new THREE.Raycaster();
    this.bindInput();
    this.resize();
    this.applyHomeCamera(1);
    this.prioritize(focus);
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  /* ---------------------------------------------------------- architecture */
  buildArchitecture() {
    const S = this.scene;
    const marbleFloor = marbleTexture('#171c21', 'rgba(210,220,230,.5)', [10, 3]);
    const marbleWall = marbleTexture('#1b2126', 'rgba(214,224,234,.55)', [1.6, 1]);
    const bronze = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: .42, metalness: .85 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: .5, metalness: .6 });
    const led = new THREE.MeshStandardMaterial({ color: 0x1a1208, emissive: 0xffc287, emissiveIntensity: 2.6, roughness: .4 });

    // Polished floor: real planar reflection under a translucent marble veil.
    if (!this.mobile) {
      this.reflector = new Reflector(new THREE.PlaneGeometry(HALL_W, HALL_DEPTH), {
        textureWidth: 512, textureHeight: 512, color: 0x777c82, clipBias: .003
      });
      this.reflector.rotation.x = -Math.PI / 2;
      this.reflector.position.set(0, 0, 0);
      S.add(this.reflector);
    }
    this.veil = new THREE.Mesh(
      new THREE.PlaneGeometry(HALL_W, HALL_DEPTH),
      new THREE.MeshBasicMaterial({ map: marbleFloor, transparent: true, opacity: this.reflector ? .78 : 1, depthWrite: false })
    );
    this.veil.rotation.x = -Math.PI / 2; this.veil.position.set(0, this.reflector ? .002 : 0, 0);
    this.veil.renderOrder = 1;
    S.add(this.veil);
    if (!this.reflector) { this.veil.material = new THREE.MeshStandardMaterial({ map: marbleFloor, roughness: .16, metalness: .35, color: 0x9aa2a8 }); this.veil.renderOrder = 0; }

    const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(HALL_W, HALL_DEPTH), new THREE.ShadowMaterial({ opacity: .38 }));
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
      const wash = new THREE.Mesh(new THREE.PlaneGeometry(BAY_W - .8, 4.3), new THREE.MeshBasicMaterial({ map: washTex, transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false }));
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
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xe8eef2, transparent: true, opacity: .75, depthWrite: false });
    const poolTex = radialTexture('rgba(255,205,150,.5)', 'rgba(255,190,120,0)');
    const contactTex = radialTexture('rgba(0,0,0,.5)', 'rgba(0,0,0,0)');
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
      const num = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.15), new THREE.MeshBasicMaterial({ map: textTexture(String(i + 1).padStart(2, '0'), { font: '500 118px Georgia, serif', color: 'rgba(226,205,170,.6)' }), transparent: true, depthWrite: false }));
      num.rotation.x = -Math.PI / 2; if (rear) num.rotation.z = Math.PI;
      num.position.set(bayX(i), .007, cz + inward * 3.4); num.renderOrder = 4; S.add(num);
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(BAY_W - .6, 7.4), new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, opacity: .34, blending: THREE.AdditiveBlending, depthWrite: false }));
      pool.rotation.x = -Math.PI / 2; pool.position.set(bayX(i), .005, cz + inward * .25); pool.renderOrder = 3;
      S.add(pool); this.pools.push(pool);
      const contact = new THREE.Mesh(new THREE.PlaneGeometry(5.1, 2.7), new THREE.MeshBasicMaterial({ map: contactTex, transparent: true, depthWrite: false }));
      contact.rotation.x = -Math.PI / 2; contact.position.set(bayX(i), .009, cz); contact.renderOrder = 5;
      contact.visible = false;
      S.add(contact); this.contacts.push(contact);
    }
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xf3e6d0, 0x2c343c, .5));
    this.spots = [];
    for (let i = 0; i < this.bayCount; i++) {
      const spot = new THREE.SpotLight(0xffd9a6, 110, 0, .66, .55, 1.8);
      const inward = i < 8 ? 1 : -1;
      spot.position.set(bayX(i), CEIL_Y - .25, carZ(i) + inward * 1.45);
      spot.target.position.set(bayX(i), 0, carZ(i));
      this.scene.add(spot, spot.target);
      // The empty rear row needs no spotlights: halves the per-fragment light count.
      if (i >= this.homeCount) spot.visible = false;
      this.spots.push(spot);
    }
    this.keyShadow = new THREE.SpotLight(0xffe2b8, 0, 0, .6, .5, 1.8);
    this.keyShadow.castShadow = true;
    this.keyShadow.shadow.mapSize.set(this.mobile ? 512 : 1024, this.mobile ? 512 : 1024);
    this.keyShadow.shadow.bias = -.0004;
    this.keyShadow.shadow.camera.near = 1; this.keyShadow.shadow.camera.far = 14;
    this.scene.add(this.keyShadow, this.keyShadow.target);
    const fill = new THREE.DirectionalLight(0xbccddd, .35);
    fill.position.set(4, 6, 8); this.scene.add(fill);
    // Overview swaps 17 spotlights for two directionals: the aerial map view
    // stays cheap enough to pan at full frame rate.
    this.overviewLights = new THREE.Group();
    const oKey = new THREE.DirectionalLight(0xffe0b0, 2.4); oKey.position.set(6, 14, 8);
    const oFill = new THREE.DirectionalLight(0xbccddd, .9); oFill.position.set(-8, 10, -6);
    this.overviewLights.add(oKey, oFill);
    this.overviewLights.visible = false;
    this.scene.add(this.overviewLights);
  }

  /* Drifting ground smoke + volumetric light shafts + dust in the beam. */
  buildAtmosphere() {
    const S = this.scene;
    this.smoke = [];
    const smokeTex = smokeTexture();
    const count = this.mobile ? 6 : 10;
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, color: 0xcfd4da, opacity: .1 + (i % 4) * .03 });
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
      const mat = new THREE.MeshBasicMaterial({ map: shaftTex, transparent: true, opacity: .16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const cone = new THREE.Mesh(shaftGeo, mat);
      cone.position.set(bayX(i), (CEIL_Y - .4) / 2 + .1, carZ(i));
      cone.renderOrder = 6;
      S.add(cone); this.shafts.push(cone);
    }
    const N = this.mobile ? 80 : 140;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - .5) * 3; pos[i * 3 + 1] = Math.random() * 4; pos[i * 3 + 2] = (Math.random() - .5) * 3; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.motes = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffe0b0, size: .035, transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
    this.motes.renderOrder = 7;
    S.add(this.motes);
  }
  updateAtmosphere(now, dt) {
    const on = !this.overview;
    const t = now / 1000;
    for (const sp of this.smoke) {
      sp.visible = on;
      if (this.reduced || !on) continue;
      const u = sp.userData;
      sp.position.x = u.x + Math.sin(t * u.speed + u.phase) * 1.6;
      sp.material.rotation += dt * .02;
      sp.material.opacity = u.base * (1 + Math.sin(t * .3 + u.phase) * .3);
    }
    for (let i = 0; i < this.shafts.length; i++) {
      const cone = this.shafts[i];
      const focused = i === this.focus && this.mode === 'home' && on;
      const target = !on ? 0 : this.mode === 'selected' ? (i === this.selected ? .22 : .05) : focused ? .26 : .1;
      cone.material.opacity += (target - cone.material.opacity) * Math.min(1, dt * 4);
      cone.visible = on && cone.material.opacity > .01;
    }
    this.motes.visible = on && this.mode === 'home';
    if (this.reduced || !this.motes.visible) return;
    const arr = this.motes.geometry.attributes.position;
    for (let i = 0; i < arr.count; i++) {
      let y = arr.getY(i) + dt * .12; if (y > 4.2) y = 0;
      arr.setY(i, y);
      arr.setX(i, arr.getX(i) + Math.sin(t * .6 + i) * dt * .05);
    }
    arr.needsUpdate = true;
    this.motes.position.set(bayX(this.focus), 0, carZ(this.focus));
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
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .8 }));
    glow.scale.set(11, 8, 1); glow.position.set(0, .7, -2.5); g.add(glow);
    this.detailGlow = glow;
    const halo = new THREE.Mesh(new THREE.TorusGeometry(2.3, .035, 8, 72), new THREE.MeshBasicMaterial({ color: 0xe6cba0, transparent: true, opacity: .55, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.position.set(0, .45, -2.4); g.add(halo);
    this.detailHalo = halo;
    const mark = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.1), new THREE.MeshBasicMaterial({ map: textTexture('VÉLANCE', { size: 512, font: '500 92px Georgia, serif', metallic: true }), transparent: true, depthWrite: false, opacity: .9 }));
    mark.position.set(0, 2.0, -1.9); g.add(mark);
    this.detailMark = mark;
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.3, 2.42, 72), new THREE.MeshBasicMaterial({ color: 0xe6cba0, transparent: true, opacity: .3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(0, .02, 0); g.add(ring);
    for (const sx of [-3.6, 3.6]) {
      const totem = new THREE.Mesh(new THREE.BoxGeometry(.05, 3.2, .05), new THREE.MeshBasicMaterial({ color: 0xf0dcb4, transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false }));
      totem.position.set(sx, 1.6, -2.3); g.add(totem);
    }
    g.visible = false;
    this.detailSet = g;
    this.scene.add(g);
  }
  placeDetailSet(index) {
    if (!this.detailSet) return;
    this.detailSet.position.set(bayX(index), 0, carZ(index));
    // Counter orbit-yaw parallax per element so the halo rings the car and the
    // wordmark sits centred above it, clear of the wall pillars.
    const t = Math.tan(this.mobile ? 1.05 : .62);
    if (this.detailHalo) this.detailHalo.position.x = -2.4 * t;
    if (this.detailGlow) this.detailGlow.position.x = -2.5 * t;
    if (this.detailMark) { this.detailMark.position.x = -1.9 * t; this.detailMark.visible = !this.mobile; }
    this.detailSet.visible = true;
  }
  /* Compile selected-view programs + shadow depth variants once, off-screen and
   * at zero light intensity, so the first crane-in never stalls on shader links
   * and no warm-up frame is ever visible. */
  warmSelected() {
    if (this.warmed) return;
    if (this.flight) { setTimeout(() => this.warmSelected(), 300); return; }
    this.warmed = true;
    const mats = new Set();
    for (const [, car] of this.cars) {
      car.visible = true;
      car.traverse(n => { if (n.isMesh) { n.castShadow = true; n.frustumCulled = false; mats.add(n.material); } });
    }
    for (const m of mats) m.userData.warmT = m.transparent;
    this.detailSet.visible = true;
    this.detailSet.position.set(0, -200, 0);
    this.detailSet.traverse(n => { if (n.isMesh) n.frustumCulled = false; });
    this.keyShadow.position.set(bayX(0) + 2.5, CEIL_Y - .3, -2.4);
    this.keyShadow.target.position.set(bayX(0), .78, carZ(0));
    this.keyShadow.intensity = 0;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    for (const m of mats) m.transparent = true;
    this.renderer.render(this.scene, this.camera);
    for (const m of mats) { m.transparent = m.userData.warmT; delete m.userData.warmT; }
    for (const [, car] of this.cars) car.traverse(n => { if (n.isMesh) { n.castShadow = false; n.frustumCulled = true; } });
    this.detailSet.traverse(n => { if (n.isMesh) n.frustumCulled = true; });
    this.detailSet.visible = false;
    this.renderer.shadowMap.needsUpdate = true;
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
        if (this.streamStarted) await new Promise(r => setTimeout(r, this.mobile ? 260 : 120));
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
          const compact = compactCar(gltf.scene);
          const holder = normalise(compact, vehicle);
          holder.rotation.y += .3 + (NOSE_BACK.has(vehicle.id) ? Math.PI : 0);
          holder.position.set(bayX(index), 0, CAR_Z);
          this.finishMaterials(holder);
          this.collectPaint(holder);
          const choice = this.paintChoice.get(index);
          if (choice) this.applyPaint(holder, choice);
          holder.traverse(n => { if (n.isMesh) n.castShadow = false; });
          holder.userData.index = index;
          holder.userData.triangles = compact.userData.triangles;
          this.scene.add(holder);
          this.cars.set(index, holder);
          this.parked++;
          this.contacts[index].visible = true;
          const ph = this.placeholders.get(index);
          if (ph) ph.userData.dying = true;
          this.renderer.shadowMap.needsUpdate = true;
          if (this.parked === 1 || this.parked === this.vehicles.length) {
            if (this.renderer.compileAsync) this.renderer.compileAsync(this.scene, this.camera).catch(() => {});
          }
          if (this.mode === 'selected' && holder.userData.index !== this.selected) {
            holder.visible = false;
            holder.traverse(n => { if (n.isMesh) { n.material.transparent = true; n.material.opacity = 0; n.material.depthWrite = false; } });
          }
          this.loadTimes[vehicle.id] = Math.round(performance.now() - started);
          this.labels[index].classList.add('is-loaded');
          this.onProgress(this.parked, this.vehicles.length, index);
          if (this.parked === 1 && !this.streamStarted) { this.streamStarted = true; this.enqueueAround(this.focus); }
          if (this.parked === this.vehicles.length) { this.onReady(); this.warmSelected(); }
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
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const swapped = new Map();
    holder.traverse(n => {
      if (!n.isMesh) return;
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      mats.forEach((mat, mi) => {
        if (!mat) return;
        let m = swapped.get(mat);
        if (!m) { m = this.tuneMaterial(mat); swapped.set(mat, m); }
        if (m !== mat) { if (Array.isArray(n.material)) n.material[mi] = m; else n.material = m; }
        this.tagPaint(m);
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'clearcoatNormalMap']) {
          if (m[key]) m[key].anisotropy = aniso;
        }
      });
    });
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
    holder.userData.paintMats = paint;
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
      m.rotation.y = .3 + (NOSE_BACK.has(v.id) ? Math.PI : 0);
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
      this.dragged = false;
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
        const span = this.mobile ? 150 : 200;
        const pos = clamp(p.base + clamp(-dx / span, -1, 1), 0, this.homeCount - 1);
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
      else this.setFocus(clamp(Math.round(this.position), 0, this.homeCount - 1));
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
    stage.addEventListener('dragstart', e => e.preventDefault());
    stage.addEventListener('wheel', e => {
      if (this.mode !== 'home' || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (this.overview) { this.ovTarget = clamp(this.ovTarget + (e.deltaX > 0 ? 2.5 : -2.5), -this.ovLimit, this.ovLimit); return; }
      // Touchpad: one car per swipe, then a short lock so it cannot chain.
      const now = performance.now();
      if (now < (this.wheelLock || 0)) return;
      this.wheelLock = now + 420;
      this.setFocus(this.focus + (e.deltaX > 0 ? 1 : -1));
    }, { passive: false });
    addEventListener('resize', () => this.resize(), { passive: true });
  }
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
  setFocus(i, silent = false) {
    const next = clamp(i, 0, this.homeCount - 1);
    this.target = next;
    this.row = rowOf(next);
    if (next !== this.focus) { this.focus = next; if (!silent) this.onFocus(next); }
    if (this.reduced) this.position = next;
    this.sortQueue();
    this.runQueue();
  }
  next() { this.setFocus(this.focus + 1); }
  prev() { this.setFocus(this.focus - 1); }

  /* ------------------------------------------------------ camera & modes */
  homePose(pos) {
    const rear = Math.round(pos) >= this.vehicles.length;
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
    this.camera.position.copy(pos); this.camera.lookAt(look);
  }
  applyOverviewState(on) {
    this.overview = on;
    this.stage.classList.toggle('is-overview', on);
    this.ceilGroup.visible = !on;
    this.southGroup.visible = !on;
    if (this.reflector) { this.reflector.visible = !on; this.veil.material.opacity = on || !this.reflector ? 1 : .78; }
    this.scene.fog.density = on ? .0075 : .0135;
    for (const [i, spot] of this.spots.entries()) spot.visible = !on && i < this.homeCount;
    // Overview must reveal every bay: undo the home neighbourhood culling so
    // distant machines are not left hidden when the aerial view opens.
    if (on) {
      for (const [i, car] of this.cars) if (!this.fades.has(i)) car.visible = true;
      for (const [i, ph] of this.placeholders) if (!this.fades.has(i)) ph.visible = !this.cars.has(i);
    }
    this.keyShadow.visible = !on;
    this.overviewLights.visible = on;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2) * (on ? .75 : 1));
    this.resize();
    if (!on) { this.ovPan = 0; this.ovTarget = 0; }
    if (this.renderer.compileAsync) this.renderer.compileAsync(this.scene, this.camera).catch(() => {});
    this.onOverview(on);
  }
  toggleOverview() {
    if (this.mode !== 'home') return;
    const on = !this.overview;
    this.applyOverviewState(on);
    const to = on ? this.overviewPose() : this.homePose(this.position);
    this.flight = { t: 0, start: performance.now(), dur: this.reduced ? 0 : 1.25, fromPos: this.camera.position.clone(), fromLook: this.currentLook(), toPos: to.pos, toLook: to.look, done: null };
  }
  select(index, hostEl) {
    if (this.mode !== 'home') return;
    if (this.overview) this.applyOverviewState(false);
    if (this.reflector) this.reflector.visible = false;
    this.mode = 'selected'; this.selected = index;
    this.prioritize(index);
    this.stage.classList.add('is-selected');
    for (const [i, car] of this.cars) if (i !== index) this.fades.set(i, { from: 1, to: 0, start: performance.now() });
    for (const [i, ph] of this.placeholders) ph.visible = i === index;
    const center = new THREE.Vector3(bayX(index), .78, carZ(index));
    const yaw = this.mobile ? 1.05 : .62, dist = this.mobile ? 9.6 : 6.6;
    this.detailHost = hostEl;
    const endPos = center.clone().add(new THREE.Vector3(Math.sin(yaw) * dist, 1.42, Math.cos(yaw) * dist));
    this.controls = new OrbitControls(this.camera, hostEl);
    this.controls.enabled = false;
    this.controls.enableDamping = true; this.controls.dampingFactor = .07;
    this.controls.enablePan = false; this.controls.enableZoom = false;
    this.controls.rotateSpeed = .55;
    this.controls.minDistance = 4.4; this.controls.maxDistance = 10.5;
    this.controls.minPolarAngle = .32; this.controls.maxPolarAngle = 1.46;
    hostEl.style.touchAction = 'none';
    this.flight = {
      t: 0, start: performance.now(), dur: this.reduced ? 0 : 1.15,
      fromPos: this.camera.position.clone(), fromLook: this.currentLook(),
      toPos: endPos, toLook: center,
      done: () => {
        if (this.reflector) this.reflector.visible = true;
        this.renderer.shadowMap.needsUpdate = true;
        this.controls.target.copy(center);
        this.controls.enabled = true;
        this.controls.update();
        this.frameViewOffset();
      }
    };
    const car = this.cars.get(index);
    if (car) car.traverse(n => { if (n.isMesh) n.castShadow = true; });
    this.keyShadow.position.set(bayX(index) + 2.5, CEIL_Y - .3, index < this.vehicles.length ? -2.4 : 2.4);
    this.keyShadow.target.position.copy(center);
    this.keyShadow.intensity = 240;
    this.placeDetailSet(index);
    // Warm shaders during the flight so the reveal never hitches on first draw.
    if (this.renderer.compileAsync) this.renderer.compileAsync(this.scene, this.camera).catch(() => {});
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
    this.camera.clearViewOffset(); this.camera.updateProjectionMatrix();
    this.stage.classList.remove('is-selected');
    for (const [i] of this.cars) if (i !== index) this.fades.set(i, { from: 0, to: 1, start: performance.now() });
    for (const [, ph] of this.placeholders) ph.visible = true;
    const car = this.cars.get(index);
    if (car) car.traverse(n => { if (n.isMesh) n.castShadow = false; });
    this.keyShadow.intensity = 0;
    this.renderer.shadowMap.needsUpdate = true;
    const { pos, look: homeLook } = this.homePose(this.position);
    this.flight = { t: 0, start: performance.now(), dur: this.reduced ? 0 : 1.0, fromPos: this.camera.position.clone(), fromLook: look, toPos: pos, toLook: homeLook, done: null };
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
    this.flight = { t: 0, start: performance.now(), dur: this.reduced ? 0 : 2.6, fromPos, fromLook: center, toPos: pos, toLook: look, done: null };
  }
  resetView() {
    if (this.mode !== 'selected') return;
    const center = this.controls.target.clone();
    const yaw = this.mobile ? 1.05 : .62, dist = this.mobile ? 10.2 : 7.4;
    this.camera.position.copy(center).add(new THREE.Vector3(Math.sin(yaw) * dist, 1.55, Math.cos(yaw) * dist));
    this.controls.update();
  }
  resize() {
    const w = Math.max(1, this.stage.clientWidth), h = Math.max(1, this.stage.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.mode === 'selected') this.frameViewOffset();
    else if (this.overview && !this.flight) this.applyOverviewCamera();
  }

  /* ---------------------------------------------------------------- loop */
  frame(now) {
    if (this.disposed) return;
    requestAnimationFrame(this.frame);
    if (document.hidden) return;
    const rect = this.stage.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= innerHeight) return;
    const settling = this.mode === 'home' && !this.flight && (this.overview ? Math.abs(this.ovTarget - this.ovPan) > .001 : Math.abs(this.target - this.position) > .002);
    const interacting = !!this.drag?.moved || !!this.flight || !!this.controls?.enabled || settling;
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
            this.focus = clamp(Math.round(this.position), 0, this.homeCount - 1);
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
      if (f.t >= 1) { this.flight = null; f.done?.(); }
    }
    if (this.controls?.enabled) this.controls.update();

    // material fades for non-selected machines
    for (const [i, fade] of this.fades) {
      const k = Math.min(1, (now - fade.start) / 600);
      const alpha = fade.from + (fade.to - fade.from) * easeInOut(k);
      const car = this.cars.get(i);
      if (car) {
        car.visible = alpha > .01;
        car.traverse(n => {
          if (!n.isMesh) return;
          n.material.transparent = alpha < .999;
          n.material.opacity = alpha;
          n.material.depthWrite = alpha > .5;
        });
      }
      if (this.spots[i]) this.spots[i].intensity = 110 * (.25 + .75 * alpha);
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

    // focused-bay light breathing + emphasis
    const breathe = this.reduced ? 0 : Math.sin(now / 1700) * .05;
    for (let i = 0; i < this.bayCount; i++) {
      const focused = i === this.focus && this.mode === 'home' && !this.overview;
      const base = this.mode === 'selected' ? (i === this.selected ? 200 : 26) : this.overview ? 130 : (focused ? 250 : 95);
      const spot = this.spots[i];
      spot.intensity += (base * (1 + (focused ? breathe : 0)) - spot.intensity) * Math.min(1, dt * 5);
      const washTarget = this.overview ? .5 : focused ? .8 : .38;
      const poolTarget = this.overview ? .3 : focused ? .5 : .22;
      this.washes[i].material.opacity += (washTarget - this.washes[i].material.opacity) * Math.min(1, dt * 5);
      this.pools[i].material.opacity += (poolTarget - this.pools[i].material.opacity) * Math.min(1, dt * 5);
    }

    // Home only renders the focused neighbourhood; distant machines stay culled.
    if (this.mode === 'home' && !this.overview) {
      for (const [i, car] of this.cars) { const near = Math.abs(i - this.focus) <= 2; if (!near) car.visible = false; else if (!this.fades.has(i)) car.visible = true; }
      for (const [i, ph] of this.placeholders) { const near = Math.abs(i - this.focus) <= 2; if (!near) ph.visible = false; else if (!this.fades.has(i)) ph.visible = true; }
    }
    this.updateAtmosphere(now, dt);
    this.renderer.render(this.scene, this.camera);
    if (this.firstFrameAt === null) this.firstFrameAt = performance.now();

    // labels projected from world anchors (front row only; rear bays stay empty)
    if (this.mode === 'home') {
      const w = rect.width, h = rect.height;
      const v = new THREE.Vector3();
      const xs = [];
      for (let i = 0; i < this.labels.length; i++) {
        if (this.overview) v.set(bayX(i), .12, carZ(i) + (this.mobile ? -3.5 : 2.8));
        else v.set(bayX(i), 2.15, WALL_Z + .4);
        v.project(this.camera);
        const el = this.labels[i];
        const x = (v.x * .5 + .5) * w, y = (-v.y * .5 + .5) * h;
        xs[i] = x;
        const onScreen = v.z < 1 && x > -160 && x < w + 160;
        el.style.transform = `translate(-50%,-100%) translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
        el.classList.toggle('is-off', !onScreen);
        el.classList.toggle('is-focused', i === this.focus && !this.overview);
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
  }
  stats() {
    const info = this.renderer.info;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    return {
      mode: this.mode, focus: this.focus, selected: this.selected,
      row: this.row, overview: this.overview,
      loaded: this.parked, total: this.vehicles.length, bays: this.bayCount, queued: this.queue.length,
      fps: this.fps,
      renderMsAvg: +(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)).toFixed(2),
      renderMsP95: +(sorted[Math.floor(sorted.length * .95)] || 0).toFixed(2),
      drawCalls: info.render.calls, triangles: info.render.triangles,
      geometries: info.memory.geometries, textures: info.memory.textures,
      loadTimes: this.loadTimes,
      firstFrameMs: this.firstFrameAt === null ? null : Math.round(this.firstFrameAt - this.t0),
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null
    };
  }
  dispose() {
    this.disposed = true;
    this.renderer.dispose();
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