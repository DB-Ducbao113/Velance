import { Color, MeshPhysicalMaterial, MeshPhysicalNodeMaterial } from 'three/webgpu';
import {
  Fn, uniform, vec3, vec4, mix, smoothstep, mx_noise_float,
  positionGeometry, positionView, positionViewDirection, faceDirection,
  materialColor, materialNormal, materialClearcoatNormal,
  materialMetalness, materialRoughness, materialClearcoatRoughness, vertexColor
} from 'three/tsl';

export const PAINT_PRESETS = Object.freeze({
  metallic: Object.freeze({ flakes: .22, flakeDensity: 540, orangePeel: .35, pearl: .08, pearlColor: '#b4c9df' }),
  pearl: Object.freeze({ flakes: .12, flakeDensity: 420, orangePeel: .25, pearl: .45, pearlColor: '#8fb7d8' }),
  solid: Object.freeze({ flakes: 0, flakeDensity: 540, orangePeel: .2, pearl: 0, pearlColor: '#ffffff' })
});

const surfaceNormal = Fn(([height, normal]) => {
  const dx = positionView.dFdx();
  const dy = positionView.dFdy();
  const r1 = dy.cross(normal);
  const r2 = normal.cross(dx);
  const det = dx.dot(r1).mul(faceDirection);
  const gradient = r1.mul(height.dFdx()).add(r2.mul(height.dFdy())).mul(det.sign());
  return normal.mul(det.abs().max(1e-10)).sub(gradient).normalize();
});

export function createCarPaintMaterial(source = new MeshPhysicalMaterial(), options = {}) {
  const settings = { ...PAINT_PRESETS.metallic, coordinateScale: 1, ...options };
  const physical = Object.fromEntries(['anisotropy', 'clearcoat', 'diffuseRoughness', 'iridescence', 'dispersion', 'retroreflectivity', 'sheen', 'transmission'].map(key => [key, source[key] || 0]));
  const material = new MeshPhysicalNodeMaterial().copy({ ...source, ...physical });
  material.userData = { ...source.userData };
  const controls = {
    flakes: uniform(settings.flakes),
    flakeDensity: uniform(settings.flakeDensity),
    orangePeel: uniform(settings.orangePeel),
    pearl: uniform(settings.pearl),
    pearlColor: uniform(new Color(settings.pearlColor)),
    coordinateScale: uniform(settings.coordinateScale)
  };
  material.paint = controls;
  material.clearcoat = Math.max(source.clearcoat || 0, .9);
  material.clearcoatRoughness = .06;

  const metres = positionGeometry.mul(controls.coordinateScale);
  const cells = metres.mul(controls.flakeDensity);
  const footprint = cells.fwidth().max(vec3(1e-5));
  const resolved = smoothstep(.5, 1.5, footprint.x.max(footprint.y).max(footprint.z)).oneMinus();
  const grain = mx_noise_float(cells).mul(.5).add(.5).clamp();
  const coverage = smoothstep(.58, .8, grain);
  const flakes = mix(.13, coverage, resolved).mul(controls.flakes);
  material.metalnessNode = mix(materialMetalness, .9, flakes);
  material.roughnessNode = mix(materialRoughness, .12, flakes);
  material.normalNode = surfaceNormal(grain.mul(flakes).mul(resolved).mul(.00012), materialNormal);

  const peelCells = metres.mul(180);
  const peelWidth = peelCells.fwidth();
  const peelResolved = smoothstep(.6, 2, peelWidth.x.max(peelWidth.y).max(peelWidth.z)).oneMinus();
  const peel = mx_noise_float(peelCells).mul(controls.orangePeel).mul(.00008).mul(peelResolved);
  material.clearcoatNormalNode = surfaceNormal(peel, materialClearcoatNormal);
  material.clearcoatRoughnessNode = materialClearcoatRoughness.add(controls.orangePeel.mul(.015).mul(peelResolved.oneMinus()));

  let base = materialColor.rgb;
  let alpha = source.transparent || source.alphaTest > 0 ? materialColor.a : null;
  if (source.vertexColors) {
    base = base.mul(vertexColor().rgb);
    if (alpha) alpha = alpha.mul(vertexColor().a);
  }
  material.vertexColors = false;
  const facing = materialNormal.dot(positionViewDirection).abs().clamp();
  const flip = facing.oneMinus().pow(3).mul(controls.pearl);
  const coat = mix(base, base.mul(controls.pearlColor), flip);
  material.colorNode = vec4(coat, alpha || 1);
  material.userData.isCarPaint = true;
  return material;
}
