# tsl-carpaint

A small layered paint material for **three.js 0.187.0**, compiled from the same TSL graph to WGSL (WebGPU) or GLSL (WebGL2). Original package code is MIT-licensed; this license does not cover the showroom's car assets.

## API

```js
import { MeshPhysicalMaterial } from 'three/webgpu';
import { createCarPaintMaterial, PAINT_PRESETS } from 'tsl-carpaint';

const paint = createCarPaintMaterial(
  new MeshPhysicalMaterial({ color: '#7c1418', roughness: .26, metalness: .65 }),
  { ...PAINT_PRESETS.metallic, coordinateScale: 1 }
);

paint.color.set('#173a5e');
paint.paint.pearl.value = .4;
paint.paint.orangePeel.value = .3;
```

The returned `MeshPhysicalNodeMaterial` preserves the source PBR textures, transparency, cutouts and ordinary `.color`, `.map` and `.needsUpdate` contract. When replacing a baked colour texture, clear `.map` and set `.needsUpdate = true`; save and restore the map for a factory-finish reset. Callers can set `.opacityNode` independently for fades.

| Live uniform | Default | Meaning |
| --- | ---: | --- |
| `paint.flakes.value` | 0.22 | Metallic microflake contribution, 0–1 |
| `paint.flakeDensity.value` | 540 | Procedural cells per metre |
| `paint.orangePeel.value` | 0.35 | Clearcoat surface relief, 0–1 |
| `paint.pearl.value` | 0.08 | Grazing-angle tint contribution, 0–1 |
| `paint.pearlColor.value` | `Color('#b4c9df')` | Pearl tint; modify with `.set()` |
| `paint.coordinateScale.value` | 1 | Geometry units → metres |

Use the holder's scale for models exported in centimetres. Presets: `metallic`, `pearl`, `solid`. Changing these uniforms or `.color` does not require rebuilding the material.

## Layers and limits

- Base coat uses source colour/maps and vertex RGB; opaque vertex alpha is deliberately excluded.
- Flakes modify metallic response, roughness and normals through the standard physical BRDF, not emissive sparkle.
- Orange peel perturbs the clearcoat normal, independently of the base-coat normal map.
- Pearl tint varies with view angle. This is an artistic angular tint, not a measured spectral paint model.
- Screen derivatives fade unresolved micro-detail into average coverage/roughness, reducing subpixel shimmer.

The package targets static display meshes. Source morph/skinning behaviour belongs to the host application's geometry pipeline. No renderer, environment, controls or asset loader is included in the package API.

## Local demo and GPU tests

From the repository root, serve with `python3 -m http.server 8090`, then open `http://localhost:8090/packages/tsl-carpaint/demo/`. Add `?backend=webgl` to force WebGL2.

```bash
npm --prefix tools/perf ci
node packages/tsl-carpaint/test/gpu.mjs
```

Tests use headed Chrome and require an actual WebGPU-capable adapter. They verify both backends, finite HDR pixels, colour restoration, parameter response, unchanged material version and mobile overflow. `CHROME_PATH`, `TEST_ORIGIN` and `QA_SHOTS` configure execution. Tests fail rather than silently treating a WebGL2 fallback as a WebGPU pass.

The package has not been published to npm; the showroom consumes its source through an importmap.
