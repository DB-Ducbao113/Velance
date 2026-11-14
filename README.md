# VÉLANCE — The Art of Performance · Luxury Cinematic Hypercar Showroom

A real-time 3D private motor gallery: eight unique GLB hypercars parked in numbered front bays
(01–08) inside a cinematic dark-luxury hall, a selected-machine stage with orbit + body-finish
paint, five cinematic 4K transparent renders per car, and a final editorial image board.
All libraries (Three.js r170, GSAP 3.14 + ScrollTrigger, Lenis 1.3) are vendored locally —
no CDN or network access required at runtime.

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
tools/optimize/          offline GLB pipeline (gltf-transform + meshopt + sharp)
tools/perf/              Vercel-Speed-Insights-style lab harness (puppeteer-core)
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
- Fallbacks: per-bay asset error swaps an editorial render into the detail stage; without WebGL the
  whole journey runs on the editorial image fallback.

## Tooling

```bash
# Performance lab (cold loads, Web Vitals + frame-cadence P50/P95/P99)
cd tools/perf && npm install && node speed_insights.mjs 4

# Offline model pipeline ( originals -> assets/models/ )
cd tools/optimize && npm install && node optimize.mjs
```

`speed_insights.mjs` reports TTFB/FCP/LCP/CLS/INP/TBT percentiles plus gate/enter/select frame
P95/P99 and the biggest resources. INP counts discrete interactions only (`interactionId`).

## Model pipeline & performance

- **Offline** (`tools/optimize/optimize.mjs`): dequantize → flatten → weld → join → prune → dedup →
  WebP textures ≤1024² → meshopt reorder + `EXT_meshopt_compression`. Quantization is deliberately
  avoided (runtime bakes node transforms on CPU). Untouched originals in `assets/models_original/`.
- **Runtime** (`src/engine/showroom.js`): focused bay loads first; the rest stream in focus-distance
  order during idle gaps, preempted by selection. Each GLB merges to one mesh per material; static
  shadow maps; both opaque and transparent shader variants pre-warmed at boot so reveals never hitch.
- **Paint**: paint-heuristic materials become `MeshPhysicalMaterial` (clearcoat 0.9); custom finishes
  drop the base colour map and restore it on `Original`. Pixel ratio capped at 2; floor Reflector
  desktop-only.

## Assets & licensing

`assets/models/*.glb` are optimized review copies; `assets/images/<id>/` holds the five 4K transparent
renders per car. **Local review only — do not publicly deploy before the source license of each
GLB/render is cleared.** Original GLBs preserved in `assets/models_original/`.