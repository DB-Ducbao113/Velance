# Gallery memory budget (2026-11-19)

The gallery loads the 16 derived `assets/models/gallery/` GLBs; selection upgrades to one `assets/models/detail/` GLB without loading the original source files. The detail preserves the existing triangle count and uses a per-car decoded texture budget of 32 MiB. BACK releases the detail geometry, materials and textures, retaining the lightweight gallery. Original assets are unchanged; the two preparation scripts and manifests record derived checksums. Derivatives do not change the asset rights restrictions.

| Asset metric (16 gallery GLBs) | Original | Derived |
|---|---:|---:|
| Transfer size | 43,311,520 B | 21,307,240 B |
| Triangles | 1,906,976 | 914,117 |
| Estimated decoded RGBA images | 533.2 MiB | 69.0 MiB |
| Estimated RGBA texture bytes including mipmaps | 710.9 MiB | 92.0 MiB |
| Accessor data | 60.4 MiB | 32.1 MiB |

These are asset-level measures/estimates, not process RSS or allocated GPU memory. Browsers may duplicate, compress or cache resources differently. The largest detail image budget is 30.375 MiB. Retina canvas is capped at 2.5 million pixels generally and 1.5 million for the constrained-memory policy; Safari/mobile also avoid MSAA and planar reflection allocation. Downloads are bounded and decode is serialized for the gallery. Archive tiles release image sources outside the surrounding scroll window; the viewer still uses the full verified image.

## Local validation

- `tools/perf/frontend_memory_smoke.mjs`: Chromium WebGPU and Chromium WebGL with Safari UA, eight select/BACK cycles plus canceled approach, 1671x896 DPR 2. Evidence: `tools/perf/results/memory/results.json`. Each return restores 68.98 MiB model images, 33.32 MiB geometry, 16 gallery resources, no retained detail and unchanged renderer texture/geometry counts. JS heap after collection increased from 22.10 to 24.33 MiB (WebGPU), 20.85 to 23.17 MiB (WebGL), so this short test is not a proof of zero leaks or a whole-process memory measurement.
- ENTER WebGPU: 16/16, zero sampled reveal violations, 4.971 s local.
- Archive WebGL: five representative photographic albums on desktop and mobile, plus small-screen diagnostics isolation, PASS.
- Static delivery and release tests: 19/19 PASS; syntax/diff checks PASS.
- Native Safari WebDriver session was blocked because Allow remote automation is disabled. No OS/browser settings changed. Actual Safari memory pressure/reload behavior remains unverified.
