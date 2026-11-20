# VÉLANCE — The Portal

The active frontend entrance is an interactive HTML/CSS/JavaScript composition,
not a screenshot of an interface.

## Asset and quality

- `assets/hero/portal-source.png`: original AI-generated architectural/car scene (1672 × 941).
  It contains no baked-in typography, UI, animated smoke or illuminated headlights.
  It is a photorealistic illustration inspired by the McLaren P1, not documentary photography.
- `portal-1600.webp`: 1600 × 900 (approximately 199 KiB).
- `portal-2560.webp`: 2560 × 1441 (approximately 381 KiB), Lanczos resampling
  and mild sharpening. This is an upscaled derivative, not native 2K/4K detail.
- Browser selects the responsive WebP with srcset. The retained PNG is not requested by the page.

## Runtime

- `index.html`: accessible real wordmark, model label and ENTER button as the only entrance control.
- `styles/landing.css`: responsive scene and aligned SVG headlight overlay; soft light
  spill, black/gold palette, vignette and forward transition.
- `src/motion/portal.js`: seeded multi-frequency procedural fog textures, continuously
  animated layers at approximately 60 Hz desktop / 30 Hz narrow devices, capped elapsed
  step, pause on hidden tab, and disposal on leaving the gate. The SVG light overlay
  transitions on and off with a 650 ms fade; ignition starts automatically after 1.2 s,
  then repeats with 4.2 s on and 1.8 s off (6 s cycle including fades).
  ENTER holds the lights on during the transition. Hidden
  tabs pause the cycle. Fog drifts, rises and expands at independent rates.
- Reduced motion: no automatic ignition cycle or fog animation loop, static fog,
  steady headlights and a stable layout.
- The actual landing starts all 16 GLB transfers in reveal order, with at most
  four concurrent fetch/decode tasks on desktop and two on narrow devices.
  GPU compilation stays serialized, textures are initialized before a car is
  counted ready, and the garage does not render behind the opaque portal.
- ENTER waits for renderer initialization, then holds the aerial view. Each bay
  reveal waits for its model, hides placeholders, and skips genuinely failed
  models without marking them loaded. The first entrance ends at ALL 16;
  selecting a bay starts a target-tracked crane and dolly, with a late hero
  framing shift. BACK returns to the same aerial pan or the selected row and
  clears pending image work, scroll animation and orbit controls. Direct `?nointro`
  visits retain one-model on-demand loading, and LIGHTS from row browsing
  replays the original camera descent. No second renderer is started.

The car and architecture are a single scene plate. Smoke and lights are live visual
effects, not physical volumetric simulation or real-time vehicle lighting. Wheels do
not rotate. No claim of actual photographed P1 footage or native 4K is made.

## Verification

`tools/perf/frontend_landing_smoke.mjs` checks both graphics backends, desktop,
mobile, small viewport and reduced-motion mode. It samples Canvas pixels twice to
verify fog changes (or remains static under reduced motion), checks headlight
opacity across automatic cycles, verifies ENTER and the existing car-detail flow.
