# VELANCE — The Art of Performance · A Full-Stack Engineering Case Study

VELANCE (brand: VÉLANCE) is a luxury cinematic hypercar showroom built as a full-stack
engineering case study: a real-time 3D private motor gallery — sixteen GLB hypercars in two
facing rows of numbered bays inside a cinematic dark-luxury hall, a selected-machine stage
with orbit + body-finish paint, five cinematic 4K transparent renders per car, and a final
editorial image board — with local-first infrastructure under active hardening. Every
performance claim in this repository is backed by measured evidence from `tools/perf`.

Rendering uses Three.js r187 WebGPU with automatic WebGL2 fallback and a standalone TSL
car-paint package. Libraries (Three.js, GSAP 3.14 + ScrollTrigger, Lenis 1.3), models and
images are vendored locally. Typography uses installed Playfair Display, DM Sans and DM Mono
when available, with Georgia/Times New Roman, Arial and system monospace fallbacks respectively.
No font downloads, third-party CSS or preconnects are required; no font files are redistributed.
Fallback font metrics and appearance may vary across operating systems.

## Project goals

1. **Cinematic showroom** — sixteen machines in two facing rows, entrance gate + crane
   flights, TSL car paint, 60 fps on desktop. The UX/visual contract is fixed; every change
   is verified visually and with the GPU harness.
2. **Production-grade infrastructure as a goal, local-first today** — Phase 1: Fleet Operations (real-session
   telemetry + ops dashboard, `tools/ops/` + `ops/`). Roadmap: delivery/CDN layer (immutable
   caching, Brotli, service worker), then CI/CD performance gates.
3. **Measured evidence** — every feature ships with before/after numbers from the
   `tools/perf` harnesses (cold-load vitals, frame cadence, full GPU journey). No unverified
   performance claims.
4. **Constraints** — local-only until each GLB/render source license is cleared; zero build
   step (vanilla ES modules); vendored dependencies; minimized local telemetry, not a guarantee of anonymity.

## Run

Node.js 24+ on PATH is required. Start the local visitor preview:

```bash
sh start.sh                    # macOS/Linux, default port 8080
sh start.sh --port 8082         # optional alternate loopback port
```

On Windows, run `start.bat` or `start.bat --port 8082` from Command Prompt.
Visit `http://127.0.0.1:8080` (or the URL printed by the launcher).
The launcher creates an allowlisted, immutable snapshot in a temporary directory,
binds only to `127.0.0.1`, and never opens the telemetry database. Private files,
Ops routes and source masters are excluded. Stop with Ctrl+C; restart to see
source changes. The equivalent direct command is
`node tools/p7/free-staging.mjs --mode review --port 8080`.

For explicitly requested diagnostics only, run the separate Ops server:

```bash
node tools/ops/server.mjs --port 8090 --db /tmp/velance-review.db
```

Use a separate disposable database path (on Windows choose a path in your temp
folder), and visit `http://127.0.0.1:8090/?diagnostics=1` to opt in through the UI.
Do not serve the repository with an unrestricted static server; ES modules require HTTP.

## Architecture

```
index.html               markup + importmap (three -> vendor/three)
styles/main.css          showroom, selected machine, archive and motion styling
styles/landing.css       black/champagne Portal layout, illuminated headlights and entrance transition
assets/hero/             generated Portal scene plate and responsive WebP derivatives; archived photograph
src/motion/portal.js     procedural Canvas fog, ignition control and lifecycle
src/ui/app.js            DOM journey: gate, home controls, selected panel, reviews, board
src/ui/archive.js        unified editorial gallery and native full-screen image viewer
src/data/archive-catalog.js  verified photographic manifests and responsive variants
styles/archive.css       warm-dark editorial gallery and accessible viewer
src/engine/showroom.js   Three.js engine: hall, bays, GLB stream, camera flights, orbit, paint
src/motion/motion.js     GSAP / ScrollTrigger / Lenis timelines + scroll reveals
src/data/vehicles.js     the sixteen machines: specs, finishes, asset ids
src/telemetry/preview.js    loopback-only explicit diagnostics preview; absent in normal visitor UI
src/telemetry/collector.js  preview opt-in/revoke: milestones, 1 Hz stats, events, errors
packages/tsl-carpaint/   independent node material, API, demo and GPU property tests
tools/optimize/          static GLB/skin bake + meshopt + texture pipeline + budget tests
tools/perf/              cold-load lab benchmark and full GPU journey checks
tools/ops/               zero-dependency Node server: static + telemetry API + SQLite
ops/                     Fleet Operations dashboard (VÉLANCE-styled, hand-rolled SVG charts)
.github/workflows/       asset/source CI + opt-in self-hosted GPU validation
assets/                  models/ (optimized), models_original/ (source), images/, archive/, environment/
vendor/                  three/, motion/ (gsap, ScrollTrigger, lenis)
```

Runtime asset URLs resolve against the page (`location.href`), so modules can live anywhere
under `src/` without touching asset paths.

## The journey

1. **Entrance** — The Portal: a black/champagne architectural scene with a
   photorealistic, AI-generated McLaren P1-inspired car. The wordmark and
   `ENTER` are real HTML. Canvas fog moves independently over the scene, and
   registered SVG headlights automatically cycle (4.2 s on, 1.8 s off).
   The scene fades and moves forward on ENTER. No wheel sprites or car cutouts
   are used. Mobile uses a composed full-car view; reduced motion presents a
   stable scene with steady headlights. Details: `docs/frontend-portal.md`.
   The landing starts bounded parallel GLB preloading in bay-light order.
   ENTER opens a wide gallery shot; each bay lights only when its real 3D
   model is ready. The first entrance stays in ALL 16 so visitors choose
   their car. `CLOSE` returns to row browsing; `LIGHTS` there replays the crane.
   Auto-skipped for `?nointro` or automated (`navigator.webdriver`) probes.
2. **Discover** — drag horizontally with a one-car detent (or arrows / prev-next) to move between
   bays. Arrow navigation stops at row edges to avoid a 45 m camera jump.
   The focused car gets a light pool + nameplate; `REAR ROW ⇅` switches to bays 09–16.
   `ALL 16 ⛶` opens an aerial overview; tap a bay to enter it.
3. **Select a machine** — others fade, the camera flies in, the model takes the left stage over a
   halo + metallic wordmark backdrop; name, specs and BODY FINISH swatches stagger in on the right.
   The 2.8–5.2-second camera timeline follows a curved crane/dolly arc with
   film-style letterbox, marquee typography, a sweeping highlight and a controlled
   lighting crescendo. Framing smoothly shifts into the detail panel before orbit
   takes control, avoiding the former final-frame projection jump. The path uses
   arc-length sampling, a continuous target-tracking quaternion, a subtle lens
   change and eased framing. Outer bays use an inward-facing hero angle. Floor
   reflections return only after the camera settles: in one local Chrome WebGL2
   trial this removed a 100.1 ms mid-flight spike (new max 16.8 ms; device-specific).
   The responsive editorial archive is prepared after the camera lands. An automatic 360-degree
   camera track then films the sides and rear with gentle radius and elevation changes.
   A short dark dissolve introduces a fixed circular detail studio with full orbit
   clearance; the car stays at its original coordinates, and the wall logo never
   follows the lens. Recessed stone wall panels, brushed-metal relief and fixed
   warm wall washes support every orbit angle. The ALL 16 view rests on a
   continuous museum plinth with a recessed light edge and no extra parking
   markings. An enclosed exhibition atrium surrounds the sixteen physical
   display cells with four continuous arcades, walls and an overhead enclosure.
   Low bay partitions and integrated practicals remain clear of the cars.
   The atrium is restored with the plinth on BACK.
   Drag interrupts the
   automatic track immediately, `AUTO` resumes or pauses it, and `FIT` restores the
   hero view and restarts the track. Reduced motion disables the automatic track.
   Normal scroll continues the page. BACK restores the original
   ALL 16 pan or the chosen row, eases the lens to its normal projection and
   cancels pending editorial work; BACK also works during the approach.
4. **Visual archive** — a single editorial photographic gallery, distinct from the live GLB and
   technical 3D render inventory. Tap an image for the native full-screen viewer with source,
   author/license, modification notice and exact dimensions, keyboard arrows, swipe and Escape.
   The album uses 640/1600px variants and 2560px only where a verified high-resolution source exists;
   the largest viewer file is fetched on opening. Missing albums explicitly fall back to labeled
   3D renders. [Photo sources](docs/frontend-photo-sources.md), [A](docs/frontend-photo-sources-a.md),
   [B](docs/frontend-photo-sources-b.md), [high-DPI derivatives](docs/frontend-photo-large.md).

## Interaction & motion

- GSAP + ScrollTrigger timelines, Lenis smooth scroll synced to the triggers.
- `prefers-reduced-motion`: Lenis/scroll animation off, gallery static, flights instant.
- Keyboard: arrows browse bays, Enter/Space activate, Escape exits detail/overview.
- Fallbacks: without WebGPU, the same TSL scene uses WebGL2. If both backends are unavailable,
  the journey uses editorial images. `?backend=webgl` forces WebGL2 for comparison.

## Tooling

```bash
npm --prefix tools/perf ci
npm --prefix tools/optimize ci

node tools/perf/speed_insights.mjs 4
node tools/perf/gpu_smoke.mjs
node tools/perf/frontend_cinematic_smoke.mjs  # replay button, 16 lights, camera, reduced motion
QA_BACKEND=webgpu QA_GATE=1 node tools/perf/frontend_cinematic_smoke.mjs  # full entrance
node tools/perf/frontend_landing_smoke.mjs  # McLaren landing desktop / mobile / reduced motion
node tools/perf/frontend_selection_smoke.mjs  # selected-car flight, projection/orbit continuity
QA_BACKEND=webgpu QA_ROW=rear node tools/perf/frontend_selection_smoke.mjs  # rear-row approach
node tools/perf/frontend_motion_profile.mjs  # frame-gap P50/P95/P99/max + camera velocity
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
- **Budgets** (`tools/optimize/budget.mjs`): 12 MiB/model, 160 MiB total GLB, 300k triangles/model,
  5M triangles total, 64 materials/model.

### Measured case study

Four cold-load runs per backend, headed Chrome on the same local macOS machine, 1440×900.
Median timing is shown; maximum frame time is the worst observed across the four runs.
Reproduce with `node tools/perf/speed_insights.mjs 4` (WebGPU) and
`node tools/perf/speed_insights.mjs 4 --url 'http://localhost:8090/index.html?backend=webgl'` (WebGL2).

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
all sixteen finishes, factory-map restoration, one-car drag, sixteen visible overview machines,
static editorial images, mobile layout and automatic fallback.

## Fleet Operations (telemetry + ops dashboard)

Local-only telemetry with Node 24 `node:sqlite`, no npm runtime dependencies or build step.
This is not a public-deployment security certification. Model/render licensing still blocks
publication; delivery/CDN and CI changes are separate work.

**P2 backend references:** [system design and HTTP/data contract](docs/backend-system-design.md)
and [local operations runbook](docs/backend-operations.md). These describe the implemented
reader/writer workers, health/metrics, backups, retention, resource limits and current gaps.
Local P2 native evidence, including the retained failed transport test and subsequent passing
run, is in [backend-p2-local.json](tools/perf/results/backend-p2-local.json); it does not
establish production-load or Internet launch readiness.

**P3 delivery/release design:** [CDN purpose, workload math, cache policies and isolation](docs/delivery-system-design.md)
and [local snapshot/activate/rollback/preview runbook](docs/delivery-operations.md).
The delivery preview is a loopback-only HTTP simulation of future CDN/private API routing,
not a configured CDN, public deployment, TLS or WAF. Releases copy only allowlisted public
bytes into immutable SHA-256 snapshots; all existing GLB/render license restrictions remain.
P3 local correctness: 24/24 delivery native tests and 30/30 backend regressions passed.
See [P3 acceptance and raw measurements](tools/perf/results/delivery-p3-acceptance.json).
Chrome cache reduced warm-origin transfer to 403 B, but constrained warm frame-gap had one
repeat exceeding the <1 ms regression target; full GPU/performance acceptance belongs to P4.

**P4 measured local capacity:** [workload model & thresholds](docs/p4-capacity-plan.md),
[fixture-only commands](docs/p4-operations.md) and [acceptance report](docs/p4-acceptance.md).
On the Apple M5 fixture with 30,000 seeded sessions and 9 million samples, 600/600
offered telemetry POSTs at 10/s were acknowledged and durable; ingest p95 3.94ms,
p99 5.62ms, dashboard p95 217.08ms, peak backend RSS 177.3MiB, integrity `ok`.
At 100/s overload, 599/1000 accepted and 401 intentionally rejected HTTP 429;
the overload scenario never claims the normal 99.9% success target.
P3 synthetic static delivery also passed 40/s steady and a 32-request GLB burst;
three paired Chrome runs on each of WebGPU/WebGL2 had all six steady-state
frame-gap-delta gates <1ms. [P4 consolidated local evidence](tools/perf/results/p4-acceptance.json).
This does **not** establish a CDN provider, real-user concurrency, months-long
availability SLO, 24-hour soak or license clearance for public publication.

**P4 stricter local simulation (17 Nov 2026):**
[extended evidence](tools/perf/results/p4-extended-acceptance.json) is PASS_LOCAL
with **16/16 P4 + 24/24 P3 + 30/30 P2** native regressions.
On constrained Chrome (20 Mbps, 40 ms), 3 paired baseline/candidate runs for each
WebGPU and WebGL2 passed all six steady-frame delta gates. Four cold-cache tabs
per backend simultaneously loaded all 16 real GLBs and completed overview/selection
with no page error. Independently, 10/25/50/**100 virtual HTTP users** streamed
real 16 GLBs + 5 editorial WebPs each (plus conditional 304), verifying every
200 response's SHA/bytes/ETag: 220/550/1100/**2200** requests all complete, global
download concurrency capped at **16**. This is NOT 100 simultaneous real browsers.
A separate 60s mixed-backend run acknowledged 600/600 telemetry POSTs, completed
270/270 reads and verified a backup during ingestion, SIGKILL/restart, duplicate
receipt replay and higher-sequence persistence without orphan rows.

**P5 system handoff — NOT a public deployment authorization:**
[system architecture](docs/p5-system-design.md),
[operations runbook](docs/p5-operations.md),
[capacity / symbolic cost model](docs/p5-capacity-cost.md),
[public-launch blockers](docs/p5-public-launch-checklist.md) and
[96-file rights review register](docs/p5-asset-rights-register.json).
No model/render file is automatically approved by SHA or filename; all 16
GLB and 80 editorial WebP files are UNVERIFIED for public distribution.
CDN provider, TLS, private origin/SSO, off-host backups, alerts and production
multiregion testing remain external launch gates.

**P7 local hardening (not a public/cloud release):**
[`docs/p7-asset-audit.md`](docs/p7-asset-audit.md) verifies the 16-GLB/80-WebP
register against source/immutable snapshot and flags two unregistered environment
WebPs; legal review remains **0/96 approved**. [`docs/p7-telemetry-consent.md`](docs/p7-telemetry-consent.md)
describes the new **explicit opt-in / withdrawal** collector. A cold page now
downloads only the focused GLB; navigation loads a requested machine and the
user-initiated overview eventually loads the full 16-model gallery. See
[`docs/p7-optimization.md`](docs/p7-optimization.md) and
[`docs/p7-acceptance.md`](docs/p7-acceptance.md) for current Chrome evidence and
G0–G4 NO-GO conditions. Historical P4 full-load numbers are from the **previous
release SHA**; the previous P5 `--mode evidence` fingerprint check should fail
against this updated frontend, as designed.

**Free-only budget policy:** no cloud account, no paid provider, no billing card,
no trial-to-paid services and no public deployment. Use
[`docs/p7-free-only.md`](docs/p7-free-only.md) for a self-contained synthetic
staging smoke and a local-only immutable full-showroom preview:

```bash
node tools/p7/free-staging.mjs --mode smoke
node tools/p7/free-staging.mjs --mode review --port 8091
```

The review server binds **127.0.0.1 only** and leaves no persistent store or
telemetry backend. Ctrl+C stops it and removes the temporary snapshot. Existing
unverified 3D and editorial media are local-review-only and remain **NO-GO for
public hosting**, even on free cloud plans.

**P8 local Security + CI/CD gates (0 VND, NO DEPLOY):**
See [P8 security review](docs/p8-security.md) and
[P8 CI/CD runbook](docs/p8-cicd.md). Both local delivery and Ops servers
now return clickjacking, referrer and browser-permission protections plus an
HTML Content-Security-Policy. Inline importmaps are SHA-256 allowlisted;
JavaScript does not require `unsafe-inline` or unrestricted `unsafe-eval`.
The security scanner rejects unsafe workflow changes, public secret patterns,
asset release-integrity violations and missing privacy/legal gates.

```bash
node tools/p8/security.mjs --mode ci
node --test tools/p8/test/headers.mjs tools/p8/test/security.mjs
node tools/p8/check.mjs --mode native
node tools/p8/release-dry-run.mjs
```

`.github/workflows/validate.yml` contains read-only, fail-closed CI with
Node 24 and an **explicitly manual ephemeral dry-run**, no upload/publish/deploy
step. Its GPU suite is manually opt-in on an existing self-hosted macOS runner.
Changes are local until committed/pushed separately; **passing a local gate is
not evidence that hosted GitHub Actions ran** or that public launch is allowed.

**P9 asset source discovery and citations:** The original downloaded GLB files
include Sketchfab exporter metadata identifying the specific model pages,
uploader handles and stated CC license. Exact original-file SHA, listing links,
one conflicting LaFerrari license claim and all 80 render-to-model associations
are recorded in [the P9 attribution table](docs/p9-source-attribution.md) and
[`docs/p9-asset-source-ledger.json`](docs/p9-asset-source-ledger.json). The
separate [original-model forensic report](docs/p9-model-forensics.md) and
[80-WebP render-lineage audit](docs/p9-render-provenance.md) distinguish exact
Sketchfab exporter provenance from copyright clearance and confirm that only
45/80 current WebPs can be byte-reproduced from the present PNG masters.
See [per-file image evidence](docs/p9-image-lineage.json) for the 35 older
non-matching assets and the two garage backgrounds without a verified origin.
The
[`docs/p5-asset-rights-register.json`](docs/p5-asset-rights-register.json)
now preserves these **discovered sources** while leaving 96/96 entries
`UNVERIFIED`. Two garage environment WebPs still have no independently
verified source. Attribution is not a substitute for legal redistribution
permission. Use `node tools/p9/source-ledger.mjs --audit` to recheck source
metadata and model links without modifying the register.

```bash
node tools/p7/check.mjs --mode native          # Node24; P7  fixture/inventory/consent gates
node tools/p6/check.mjs --mode native          # P6 security + P4/P3/P2 regression
node tools/p7/browser_lazy.mjs --out tools/perf/results/p7-lazy-browser-review.json
node tools/p7/check.mjs --mode evidence \
  --browser tools/perf/results/p7-lazy-browser-review.json \
  --out tools/perf/results/p7-local-acceptance-review.json
```

```bash
node tools/delivery/check.mjs  # P3 native protocol/release tests + P2 regression
node tools/perf/p4_check.mjs   # P4 syntax/native plus P3/P2 regression; heavy load is opt-in
node tools/p5/check.mjs --mode native    # CI-safe P5 handoff source/native gate
node tools/p5/check.mjs --mode evidence  # Verify P4-tested release matches current files
node tools/p5/readiness.mjs --out tools/perf/results/p5-readiness-new.json
```

The backup scheduler runs only when `--backup-dir` is supplied. `operations.mjs` supports
manual `backup`, `verify`, `restore` to a new path, and `retention` preview/apply; see the
runbook for safe temporary-database commands. Metrics expose local Prometheus-format counters,
histograms and alert **gauges**, with no configured notification delivery. No automatic
telemetry retention schedule or production access-control boundary exists.

```bash
node tools/ops/server.mjs          # http://127.0.0.1:8090 — showroom + API + /ops/
node tools/ops/server.mjs --port 0 --db /tmp/velance-review.db
node tools/ops/check.mjs           # Node 24+: syntax + isolated native tests, no real DB
node --test tools/ops/test/server.mjs tools/ops/test/collector.mjs
QA_SHOTS=/tmp/velance-ops-shots node tools/perf/ops_smoke.mjs
```

### Local boundary and storage

- Bind defaults to `127.0.0.1`; CLI `--host` accepts only loopback (`127.0.0.1`, `localhost`,
  `::1`). Host must match a loopback hostname and the listening port. Foreign/null Origin and
  cross-site Fetch Metadata are rejected. This is not authentication against other local apps.
- Static delivery has a path/type allowlist: showroom HTML, dashboard HTML/CSS/JS, `src` JS,
  `styles` CSS, `vendor` JS/WASM, car-paint source/demo, optimized GLB, images/environment WEBP,
  plus prepared numeric-width Archive WebPs, the two exact active Portal WebPs,
  and the exact render harness HTML. Canonical paths must remain both in-root and public.
  Dotfiles, `.git`, `node_modules`, originals/prepared assets, Archive staging, hero PNG masters, the configured DB
  and its sidecars/backups are not served, including through symlinks. `/ops` redirects to `/ops/`.
- `tools/ops/telemetry.db*` is local and gitignored. A legacy-schema migration writes a
  native SQLite backup with a `.pre-v2-<timestamp>-<uuid>.bak` suffix before upgrading to
  schema v2 (receipt keys and `last_seq`), preserving historical sessions. Previous
  hardening-era `.pre-hardening-*.bak` snapshots may also exist.
  Custom `--db` paths/backups must be kept out of version control by their owner.
- APIs: `POST /api/telemetry`, `GET /api/summary`, `GET /api/sessions?limit=50` (integer 1–200),
  `GET /api/sessions/:id`. JSON POST supports UTF-8 charset, not compressed request bodies.
  Cap: exactly 262,144 bytes, including whitespace; larger fixed/chunked bodies return complete
  HTTP 413 JSON. Invalid JSON/shape/limit is 400; foreign origin 403; absent resource 404;
  wrong known-route method 405 + Allow; unsupported media/encoding 415. Internal errors are generic.
- Validation rejects the entire batch on invalid fields, types, enums or bounds; it never cuts
  serialized JSON. Maximum 2,000 samples, 500 events, 64 load-time entries, UA 512 characters,
  error message 300 characters. Times/counters are nonnegative safe integers where applicable;
  measured values are finite nonnegative numbers or null.
- `(session_id, seq)` receipts persist across restart. Replays return 200 without changing rows
  or receipt time. Out-of-order new batches import new sample/event keys but cannot regress
  newer metadata. Missing metadata can be filled; null final stats cannot erase loadTimes.
  Session start/context remain immutable once known. Receipts and data commit/rollback together.

### Collector semantics and privacy

- Telemetry is **off by default**. Only an explicit **Allow optional diagnostics** choice
  (or unexpired saved versioned consent) permits a document HEAD capability probe.
  Collection starts only when the source returns `X-Velance-Ops: 1`; plain static visits
  with no consent perform **no telemetry HEAD, POST, UUID, context or timers**.
  Users can revoke consent through the settings panel; `?notelemetry` always overrides
  saved consent for that URL. Client controls are not a substitute for server-side
  retention/deletion or an approved legal/privacy notice.
- Boot probe: 250 ms. Sampling starts **after the first GLB is loaded** (new P7 lazy mode),
  at most 1 Hz and paused while hidden. The `allLoaded` milestone remains optional and
  is recorded only if the full 16 models become ready after explicit gallery exploration.
  No added per-frame work or engine changes. Regular batches every 10 seconds are single-flight;
  each payload is at most 48 KiB UTF-8, with bounded queues (1,200 samples / 500 events).
  Excess queued observations are dropped, not persisted offline.
- Milestones and context travel in checkpoints even without samples. Hidden/pagehide use beacon
  with keepalive fetch fallback; BFCache restores the same session and one timer set. Transport
  is **best effort**: beacon acceptance is not server receipt, close/crash may lose data, and a
  failed fetch disables collection without retries. Terminal checkpoints do not drain an
  arbitrarily large backlog. There is no zero-loss guarantee.
- Milestones share the collector clock. GLBs load behind the entrance gate, so firstCar/allLoaded
  may precede enter. Image fallback records `images` and an engine error, not a fabricated
  allLoaded. Unknown values remain null, never zero. Engine FPS is rolling **active cadence**;
  idle/offscreen samples report null rather than reusing stale FPS. Historical samples are not
  reinterpreted or rewritten. Phase summary `n` counts rows; `fpsN` counts known FPS values.
  Percentile is the sorted finite value at `min(n-1, floor(q*n))`, not interpolation.
- Collected: random per-page session ID, time, browser UA, coarse/mobile indicator, screen/DPR,
  core/memory/network class, WebGPU/reduced-motion capability, renderer metrics, listed UI events,
  and shortened error messages. No collector fields for account/contact, IP, cookies, request
  headers or page URL/query. Obvious URLs, queries and token-like text are redacted from errors;
  this is not an exhaustive PII filter. UA/device/error text may identify a user. Local storage
  is not encrypted and there is no scheduled telemetry retention job. Typography uses local
  installed fonts and does not send requests to a font provider.

### Dashboard and regression coverage

The existing SVG layout shows KPIs, load trend, phase cadence, device mix and a session register.
Missing series/FPS remain gaps, late-enter waterfalls stay within 100%, auto-refresh does not
scroll, and stale detail requests cannot reopen a closed panel or replace a newer selection.

Native tests use temporary roots/DBs and cover file/HTTP boundaries, exact byte caps, JSON,
ordering, rollback, migration, summary fixtures and deterministic collector lifecycle. The headed
browser runner uses an isolated DB, real WebGPU/WebGL2 journeys, observed milestone timing,
actual received lifecycle checkpoints, opt-out/static/failure cases, dashboard races and the
render harness (without overwriting assets). Its BFCache case uses an image-fallback fixture
without a live WebGPU device. Existing full-fleet and car-paint GPU suites remain separate:

```bash
TEST_ORIGIN=http://127.0.0.1:8090 node tools/perf/gpu_smoke.mjs
TEST_ORIGIN=http://127.0.0.1:8090 node packages/tsl-carpaint/test/gpu.mjs
TEST_ORIGIN=http://127.0.0.1:8090 node tools/perf/measure.mjs
TEST_ORIGIN=http://127.0.0.1:8090 QUERY=notelemetry=1 node tools/perf/measure.mjs
```

Run GPU tools sequentially. The legacy harness key `enterToFirstCarGaps` actually measures
ENTER→**allLoaded**, not firstCar. The historical eight-car render table above is a separate
experiment, not a sixteen-car Fleet Ops overhead measurement.

### Fleet Ops hardening measurement — 2026-11-15

Evidence: [`tools/perf/results/ops-hardening.json`](tools/perf/results/ops-hardening.json).
Twelve runs: three alternating ON/OFF pairs before and three after, headed Chrome on macOS/ARM64,
WebGPU, 1440×900, cache disabled. All runs are retained; all console/page error counts are zero.
Selected averages are the mean of six per-car averages. These are local lab results, not field data.

| Frame-gap metric | Before paired median ON−OFF | After paired median ON−OFF | After worst p95 ON / OFF | After worst max ON / OFF |
| --- | ---: | ---: | ---: | ---: |
| Enter → allLoaded | 0.00 ms | +0.10 ms | 17.5 / 17.3 ms | 33.5 / 41.6 ms |
| Overview | −0.10 ms | +0.20 ms | 16.7 / 16.7 ms | 17.6 / 17.5 ms |
| Selected | +0.017 ms | −0.017 ms | 9.3 / 9.3 ms | 9.4 / 25.1 ms |

All three paired-median overhead gates pass **<1 ms**. This does not mean p95/max were unchanged:
overview p95 increased between stages, and load timing drifted in both ON and OFF runs. After-stage
allLoaded ON−OFF differences were +14, +256 and −500 ms, so these three pairs do not establish a
consistent load-time regression or statistical equivalence. No outlier was removed.

Hardening verification also passed 15 native tests, the real-browser Ops suite, both backends across
all 16 cars plus automatic WebGL2 fallback, and both car-paint demo backends. Additive migration and
a readable native backup preserved all 18 existing sessions, 399 samples and 253 events.

## Assets & licensing

`assets/models/*.glb` are optimized review copies; `assets/images/<id>/` holds the five 4K transparent
renders per car. **Local review only — do not publicly deploy before the source license of each
GLB/render is cleared.** Original GLBs preserved in `assets/models_original/`.
