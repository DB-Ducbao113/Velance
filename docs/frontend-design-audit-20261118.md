# VÉLANCE — Frontend design audit (2026-11-18)

Scope: read-only design/UX audit of the local `frontend` working tree; no redesign, asset replacement, commit, push or deployment. The existing Portal is the approved visual direction. The findings below combine inspection of source code with an actual Chrome WebGL2 journey through the entrance, overview, Bugatti Tourbillon detail, Angles and Archive.

## Evidence

- Screenshots: `tools/perf/results/design-audit/` (desktop and mobile; landing, overview, detail, angles, archive).
- Desktop 1440×900 and emulated mobile 390×844: completed the audited journey, no page JavaScript errors or horizontal document overflow.
- One selected album contains five unique images, instantiated ten times across Angles and Archive. The same album is repeated, not ten distinct photographs.
- Selected document height: 7,438 CSS px desktop; 6,217 CSS px mobile.
- Current image inventory: 80 WebP files, 36.9 MiB aggregate; local PNG masters approximately 130.6 MiB. McLaren P1's five WebPs total 3.13 MiB. Aggregate inventory is not per-page network transfer.
- Desktop journey reported 4,186,498 transferred bytes for resources under `assets/images/` (includes gallery assets). The subsequent mobile run reused the browser cache, so its zero transfer measurement is not a cold-load result.
- Mobile detail: paint swatches 19×19 CSS px, AUTO/FIT 30 px tall, primary and BACK buttons 40 px tall. Increase actual hit areas without making the visible marks unnecessarily large.
- Limitations: one car detail sampled (Tourbillon); Chrome emulation is not a real phone, no new WebGPU or cold-cache performance certification, no cross-browser test. First attempt tried to activate VIEW before the overview entrance completed; rerun waited for the completed overview and selected a visible bay.

## Priorities

| Priority | Finding | Recommendation / acceptance |
| --- | --- | --- |
| P0 | Render-based Angles/Archive repeat the same five images; the sampled car occupies little of each card, especially on mobile. | Separate technical 3D previews from a genuine editorial photo archive. Use correctly identified real vehicles, approved source/author/license and editorial crops. Start with McLaren P1 and Tourbillon. Show only available verified photographs, never label a render or generated image as a real photograph. |
| P0 | Overview labels overlap cars and truncate model names on mobile. | Keep 16-bay overview on desktop; on mobile show bay numbers on the scene and one readable active-car label, with row browsing or a compact car picker. All 16 remain reachable; taps select the intended bay. |
| P0 | Floating optional diagnostics control visually clashes and partially covers mobile BACK. | Integrate consent/settings into a discreet accessible settings entry; keep opt-in and withdrawal available, preserve default-off behavior, do not cover navigation. |
| P1 | Five viewport-height Angles plus a repeated Archive impose excessive scrolling and duplicate navigation. | Combine into one editorial Archive, one lead photograph and a compact photo grid; clicking opens an accessible full-screen image viewer with previous/next, escape/back and mobile swipe. Keep a single clear BACK route restoring the previous gallery context, and optional direct access to other cars. |
| P1 | Sampled live 3D material/lighting looks less refined than the Portal; bright turquoise highlights and visible aliasing reduce perceived realism. | Tune material-specific roughness, exposure, environment lighting, shadow and parked detail quality. Preserve model geometry, adaptive pixel ratio and fast motion, measure before changing rendering quality caps. |
| P1 | The portal has a pleasing desktop composition, but portrait layout has large black areas and the wide background is reduced substantially. | Keep black/champagne concept and current automatic lighting/fog; create deliberately composed portrait background; improve source-native resolution if an appropriate asset exists. Do not upscale and claim native 4K. A small focus ring should remain keyboard-visible without appearing as permanent decoration. |
| P1 | Detail has two BACK actions, small labels/swatches and an overly prominent technical status/edition presentation in places. | Keep vehicle name, year, four key specs, paint choices and one photo action. Improve readable type and touch hit areas; remove internal model-version nomenclature if it is not meaningful to public visitors. |
| P2 | Cream/blue-grey alternating Angles sections interrupt the warm dark Portal identity; archive has excessive whitespace. | Use shared obsidian/graphite/champagne tokens, consistent type scale, crop/aspect-ratio rules and simple motion. A light editorial section is optional only if deliberately chosen. |
| P2 | Full-size photos are attached to both sections immediately after camera landing; current source has no explicit thumbnail variants/lazy strategy in attachImage. | Use independent archive manifest, generated responsive WebP/AVIF variants, thumbnails around 640–960 px, 1600–2400 px editorial images, original 3K/4K only where available for viewer. Lazy load below the fold, reserve aspect ratio, and decode full-resolution on demand. |

## Photo sourcing

Maintain a separate photographic album manifest rather than overwriting the five render paths currently used by bay labels, loading previews and fallback mode. For each photo record the actual make/model/variant, angle, source URL, author, license/permission, modification information, resolution and photo/render classification. Prefer one strong lead photo, side/rear, interior/cockpit and genuine detail. Use a dark editorial color grade conservatively and retain the original scene (no poor-quality vehicle cutouts). Real photo colors are documentary and independent of the interactive paint configurator. Only use verified originals for native resolution claims. Missing photos should be omitted or explicitly labeled as renders if a separate technical preview is shown. Manufacturer specification source URLs are not photo licenses; the existing P9 provenance report also does not approve the image/model rights.

## Proposed sequence

1. Pilot a genuine photo Archive for P1 and Tourbillon, with verified assets and before/after visual review.
2. Unify Angles/Archive, photo viewer, short navigation and mobile collection selection; integrate diagnostics without losing consent functionality.
3. Polish 3D lighting/materials, touch targets and mobile Portal composition.
4. Roll out photo coverage to the remaining vehicles as suitable sources are verified.
5. Retest visual snapshots, keyboard/touch, selection/return, modal viewing, missing-image fallback, reduced motion, both graphics backends and real-device performance. Measure cold-cache requests separately.

No additional decorative animation, slogans, sound, background music or unrelated pages are required. Quality of the imagery and coherence of the journey are the goal.
