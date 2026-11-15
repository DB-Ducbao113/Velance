# VÉLANCE — The Art of Performance · Luxury Cinematic Hypercar Showroom

A real-time 3D private motor gallery: eight unique GLB hypercars parked in numbered front bays
(01–08) inside a cinematic dark-luxury hall, a selected-machine stage with orbit + body-finish
paint, five cinematic 4K transparent renders per car, and a final editorial image board.
Rendering uses Three.js r187 WebGPU with automatic WebGL2 fallback and a standalone TSL
car-paint package. Libraries (Three.js, GSAP 3.14 + ScrollTrigger, Lenis 1.3), models and
images are vendored locally; Google Fonts remains an optional network typography resource.

## Run

```bash
python3 -m http.server 8090     # or ./start.sh (serves on 8080)
```

Visit `http://localhost:8090`. Any static file server works; ES modules require HTTP (not `file://`).

## Architecture

```
index.html               markup + importmap (three -> vendor/three)
styles/main.css          all styling (data-URI textures only, no relative url())
src/ui/app.js            DOM journey: gate, home controls, selected panel, reviews, board
src/engine/showroom.js   Three.js engine: hall, bays, GLB stream, camera flights, orbit, paint
src/motion/motion.js     GSAP / ScrollTrigger / Lenis timelines + scroll reveals
src/data/vehicles.js     the eight machines: specs, finishes, asset ids
packages/tsl-carpaint/   independent node material, API, demo and GPU property tests
tools/optimize/          static GLB/skin bake + meshopt + texture pipeline + budget tests
tools/perf/              cold-load lab benchmark and full GPU journey checks
.github/workflows/       asset/source CI + opt-in self-hosted GPU validation
assets/                  models/ (optimized), models_original/ (source), images/, environment/
vendor/                  three/, motion/ (gsap, ScrollTrigger, lenis)
```

Runtime asset URLs resolve against the page (`location.href`), so modules can live anywhere
under `src/` without touching asset paths.

## The journey

1. **Entrance gate** — a luxurious landing veil; `Enter the gallery` cranes the camera down
   into the hall. Auto-skipped for `?nointro` or automated (`navigator.webdriver`) probes.
2. **Discover** — drag horizontally with a one-car detent (or arrows / prev-next) to move between
   bays. The focused car gets a light pool + nameplate; rear bays 09–16 stay empty.
   `FULL GALLERY ⛶` opens an aerial overview of all eight machines; tap a bay to enter it.
3. **Select a machine** — others fade, the camera flies in, the model takes the left stage over a
   halo + metallic wordmark backdrop; name, specs and BODY FINISH swatches stagger in on the right.
   Drag to orbit, `FIT` resets the view (no zoom). Normal scroll continues the page.
4. **Five cinematic angles** — scroll-driven crossfade through five static 4K alpha renders per car;
   chapter numbers/titles reveal in stagger; scrolling backwards reverses the sequence.
5. **Visual archive** — editorial board of the same five renders; hover lifts a frame, click returns
   to that chapter. The two nav tabs appear only once a machine is selected.

## Interaction & motion

- GSAP + ScrollTrigger timelines, Lenis smooth scroll synced to the triggers.
- `prefers-reduced-motion`: Lenis/scroll animation off, chapters stack statically, flights instant.
- Keyboard: arrows browse bays, Enter/Space activate, Escape exits detail/overview.
- Fallbacks: without WebGPU, the same TSL scene uses WebGL2. If both backends are unavailable,
  the journey uses editorial images. `?backend=webgl` forces WebGL2 for comparison.

## Tooling

```bash
npm --prefix tools/perf ci
npm --prefix tools/optimize ci

node tools/perf/speed_insights.mjs 4
node tools/perf/gpu_smoke.mjs
node packages/tsl-carpaint/test/gpu.mjs
npm --prefix tools/optimize test
node tools/optimize/budget.mjs
node tools/vendor/verify.mjs

# Sources are not overwritten; inspect output before replacing published GLBs.
node tools/optimize/prepare.mjs --input assets/models_original --out assets/models_prepared
```

`speed_insights.mjs` reports cold-load timing and frame cadence. Its interaction latency is a
lab proxy (maximum Event Timing duration), not production field INP. Results depend on the
machine, browser cache and GPU driver. Headed GPU tests require installed Chrome; configure
`CHROME_PATH`, `TEST_ORIGIN` and optional `QA_SHOTS` as needed.

CI always checks geometry/payload budgets, prepared-asset checksums, pipeline unit tests,
vendored Three.js checksums, syntax and package contents. GPU CI is opt-in via workflow dispatch
and requires a configured self-hosted macOS/ARM64 runner labelled `gpu`; hosted CPU runners
are not presented as hardware-WebGPU validation.

## Model pipeline & performance

- **Offline** (`tools/optimize/prepare.mjs`): dequantize → bake node transforms and bind-pose skin →
  prune/dedup/weld/join → texture encoding → meshopt reorder/compression. Runtime CPU compaction
  and skin baking have been removed. The prepared GLBs carry pipeline-version metadata and a
  SHA-256 manifest. Originals remain local and gitignored.
- **Textures**: existing WebP textures are retained without another lossy encode; PNG/JPEG sources
  convert to WebP ≤1024². `--ktx2` uses the external KTX-Software `toktx` encoder for UASTC+mipmaps
  and emits `KHR_texture_basisu`. The renderer supports KTX2 workers, but the bundled models
  currently remain WebP because no KTX encoder was installed. Texture memory is still a major
  budget (about 257 MiB estimated); it is not claimed as solved by the WebGPU port.
- **Runtime**: focused bay first, meshopt decoding in workers, serialized async shader compilation
  before a car becomes visible. A fixed light set switches modes by intensity instead of rebuilding
  every lit shader. Car fades use stable blending state; the desktop floor combines a TSL reflector
  and marble in one material. Pixel ratio is capped at 2 desktop / 1.5 mobile, then reduced in overview.
- **Paint**: large exterior panels use `packages/tsl-carpaint`: base coat, metallic flakes, independent
  clearcoat orange peel and angular pearl tint. Factory maps are saved/restored by the configurator.
  The independent demo is at `http://localhost:8090/packages/tsl-carpaint/demo/`.
- **Budgets**: 9 MiB/model, 40 MiB total GLB, 600k triangles/model, 2.6M triangles total, 64 materials/model.
  Review these explicit limits before adding the additional machines.

### Measured case study

Four cold-load runs per backend, headed Chrome on the same local macOS machine, 1440×900.
Median timing is shown; maximum frame time is the worst observed across the four runs.
Raw evidence is in `tools/perf/results/`.

| Metric | r170 WebGL baseline | r187 WebGPU + TSL | r187 WebGL2 + TSL |
| --- | ---: | ---: | ---: |
| TBT | 3,946 ms | 9 ms | 84 ms |
| Interaction latency proxy | 576 ms | 48 ms | 48 ms |
| First car loaded | 683 ms | 565 ms | 632 ms |
| All eight loaded | 4,963 ms | 2,182 ms | 2,342 ms |
| First select: max frame | 154 ms | 23.7 ms | 37.8 ms |
| Overview switch: max frame | 1,078.1 ms | 18 ms | 18.3 ms |
| Total loaded payload | 40.32 MiB | 37.03 MiB | 37.03 MiB |
| Home draw calls | 275 | 218 | 218 |
| Selected draw calls | 134 | 150 | 150 |

The largest gain comes from removing shader/state-transition stalls and preparing static assets,
not from replacing the backend alone. Selected draw calls increase with the new rendering path;
these results do not establish the same improvement on other devices. GPU tests also verify
all eight finishes, factory-map restoration, one-car drag, eight visible overview machines,
static editorial images, mobile layout and automatic fallback.

## Assets & licensing

`assets/models/*.glb` are optimized review copies; `assets/images/<id>/` holds the five 4K transparent
renders per car. **Local review only — do not publicly deploy before the source license of each
GLB/render is cleared.** Original GLBs preserved in `assets/models_original/`.