# Frontend photographic Archive — local acceptance, 2026-11-18

Branch: `frontend`. Local review only; no commit, push, merge or public deployment.

## Inventory and resolution

- All 16 vehicles have photographic albums (3–4 photos each), totaling 57 distinct photos and 183 distinct WebP runtime assets, 70,820,492 bytes. No missing or orphaned WebPs in the audited archive.
- Fifteen primary photos are 3840 px wide; fourteen are at least 3840 × 2160. Valkyrie's 3840 × 1934 panorama preserves its source aspect ratio. The 765LT lead is 1920 × 1185; its second photo is 1920 × 1460. The available verified retrieval does not establish 4K for that car.
- Higher-resolution Wikimedia published renditions were retrieved and checked, not assumed from metadata of the original file. No archive photograph was upscaled. Some secondary views are smaller, and the viewer displays the actual delivered dimensions.
- Responsive 640/1600 and, where supported, 2560 px variants; the full viewer file is fetched on opening. The additional 2560 px variants are downsampled from the verified viewer WebP, not claimed as original source bytes.
- Each record retains the photograph source, contributor, license and modification notice. See `frontend-photo-sources.md`, `frontend-photo-sources-a.md`, `frontend-photo-sources-b.md`, and `frontend-photo-large.md` for provenance and hashes.
- No new AI images were generated: the image generation tool was unavailable in this session. Existing approved Portal art remains unchanged (1672 × 941 original generated image, responsive derivative up to 2560 px; not native 4K).

## Interaction and delivery

Unified dark editorial Archive, native modal, full-size uncropped viewing, responsive cards, source credits, keyboard arrows/Escape, real touch swipe, image decode race protection and focus restoration. Fixed the narrow-screen viewer grid so the image fills the available width, verified against the actual rendered screenshot. Render-only fallback remains explicitly labeled. Portal and showroom visual design preserved. Diagnostics remain an explicit local-only preview, not ordinary visitor navigation.

The static delivery allowlist now covers exact active Portal WebPs and bounded Archive WebP paths; symlink handling remains fail-closed. No telemetry database logic was modified.

## Verification

| Test | Result |
| --- | --- |
| `tools/perf/archive_asset_audit.mjs` | PASS — all 57 photo records, 183 assets, hashes, actual WebP dimensions, provenance, no orphan assets |
| `tools/perf/frontend_archive_catalog.mjs` | PASS — 32 album/device combinations, 114 full-image checks, two labeled render fallback checks; desktop and 320px mobile, keyboard and modal lifecycle |
| `tools/perf/frontend_archive_smoke.mjs` | PASS — 16 sampled showroom journeys across WebGL2/WebGPU, desktop/mobile; isolated small-screen diagnostics check |
| Delivery and P7 consent native tests | 34/34 PASS |
| P8 local security and ephemeral delivery dry-run | PASS_LOCAL / PASS_LOCAL_ONLY; no public launch authorization |
| `git diff --check` | PASS |

Evidence: `tools/perf/results/archive-final/assets.json`, `tools/perf/results/archive-final/results.json`, `tools/perf/results/archive-catalog/results.json`, and the corresponding screenshot directories. Browser tests were rerun after all photo manifests stabilized and the mobile viewer fix landed. No physical-phone or native 4K-display visual certification is claimed. Public redistribution of the complete application remains subject to the existing asset-rights release gate.

## Follow-up high-resolution acceptance — latest inventory (2026-11-18)

This section supersedes the earlier inventory and resolution limitations above; the previous section remains historical evidence.

- Retention audit against `tools/perf/results/archive-hd/baseline-assets.json`: all 57 prior photo sources preserved without dimensional downgrade; 17 same-source full-resolution upgrades, four distinct new photos, 61 total. All 16 cars now have at least one photo at least 3840 × 2160. There are 36 photos at width 3840, of which 33 also have height at least 2160. No enlargement or crop to force UHD dimensions.
- Priority leads: McLaren 765LT 3840 × 2230 (additional Onyx Black 3840 × 2880); Valkyrie 3840 × 2563 (additional doors-up 3840 × 2566). The existing yellow Valkyrie was upgraded to 3840 × 2893. Each priority album now contains five photos. The older Valkyrie panorama and two newly upgraded wide rear views remain below 2160 height and are not counted as UHD-qualified.
- 216 active WebP files, 112,597,854 bytes (107.38 MiB), versus 70,820,492 bytes previously. This is the complete local inventory, not a page-load measurement. No missing albums or orphaned runtime WebPs. Five obsolete B full-size variants were retained in ignored local staging folders, excluded from delivery; their paths are listed in `archive-hd/retired-variants.json`. Other replaced renditions were retired by their preparation steps. Every original photographic source remains represented in the catalog.
- The 36 large variants have proportional 2560px gallery derivatives; existing 640/1600 tiers are retained where appropriate. Raw retrieved source dimensions and hashes, authors, licenses and variant hashes are documented in the photo-source files. Secondary images whose original size/aspect or bounded acquisition does not support a verified higher-quality rendition remain unchanged. All acquisition work is concluded; no retry of previously failed hosts.
- Native image generation is unavailable in this session; no new AI image was generated. Portal original and both WebP variants, landing CSS and fog/light script have unchanged SHA-256 hashes. Existing 1672 × 941 generated source still limits genuine detail; the historical 2560px derivative is not native 4K. The approved composition and behavior were intentionally retained.

### Measured image delivery and acceptance

Cold-cache browser fixture, actual HTTP 200 image-response Content-Length totals for an entire album grid after scrolling each tile into view, before opening the viewer. Not network protocol overhead or time-to-load. Results are from emulation, not physical devices.

| Viewport | Minimum album payload | Maximum album payload | Mean album payload |
| --- | ---: | ---: | ---: |
| 1440 × 900 DPR 1 | 277,228 B | 906,650 B | 480,783 B |
| 1440 × 900 DPR 2 | 785,098 B | 2,437,934 B | 1,599,733 B |
| 320 × 640 DPR 2 | 106,192 B | 275,088 B | 179,120 B |

No viewer-only full-size image requested during grid loading. Both priority leads selected the 2560px tier on desktop DPR 2, 1600px on desktop DPR 1 and 640px on 320px mobile. The small existing photos may reuse their largest available variant in both grid and viewer. Full-resolution photographs are fetched on viewer interaction.

| Fresh check | Result |
| --- | --- |
| Archive asset audit with baseline retention | PASS — 61 photos; 216 WebPs; all previous sources retained |
| Browser catalog | PASS — 48 album/viewport combinations; 183 full-image verification instances; three fallback checks |
| Integrated showroom | PASS — 20 journeys (five sampled cars, desktop/mobile, both WebGL2 and WebGPU); small diagnostics isolation |
| Portal WebGL2 | PASS — desktop, mobile, 320px, reduced motion, including two consecutive automatic light cycles |
| Visual review | PASS — priority sources compared, desktop 765LT viewer, mobile Valkyrie viewer and mobile 765LT gallery reviewed |
| Git diff check | PASS |

Latest evidence: `tools/perf/results/archive-hd/assets.json`, `catalog/results.json`, `integrated/results.json` and corresponding screenshot directories under `archive-hd`; Portal screenshots at `tools/perf/results/archive-hd-portal/`. No fresh public launch approval, commit, push, merge or deployment. Native physical-device and 4K-display testing remain outside this local acceptance.
