# PROJECT PROFILE — VELANCE (provisional, derived from repository)

This profile records observed decisions in README, existing code, local policy and the owner's 2026-11-19 remediation request. Unknown fields remain [TBC]; this is not a new product specification or an owner sign-off.

## 1. What the project is
- Name: VELANCE / VÉLANCE private interactive 16-car hypercar showroom, engineering case study.
- Users: local visitor and local operator/maintainer. Public audience and release rights [TBC].
- Core value: interactive 3D showroom, selective detail models, editorial archive, demonstrated performance and local infrastructure.
- Stage: working local prototype/maintenance, not approved for public production.

## 2. Technology
- Frontend: vanilla HTML/CSS/ES modules, Three.js r187 WebGPU with WebGL2 fallback, GSAP, Lenis, TSL car paint, Canvas portal.
- Backend: Node.js 24, built-in HTTP delivery and optional Ops application; immutable allowlisted snapshots.
- Database: local SQLite telemetry only with explicit opt-in; no schema change in current task.
- Auth: no public account system; privileged Ops local-only. Any future auth architecture [TBC].
- Hosting: loopback local preview, no public deployment authorized; platform/region [TBC].
- Repo: current `frontend`, `main` and `origin/main` last inspected at f3591cc; uncommitted work preserved. No commit/push/merge/deploy assumed.

## 3. Design system & brand
- Tokens and layouts: `styles/main.css`, `styles/landing.css`, `styles/archive.css`, `styles/showroom-refinement.css`; existing visual contract in README and frontend docs.
- Dark obsidian/champagne/cream palette; typography declared in CSS; preserve the existing brand and local fallbacks.
- Wordmark and iconography: existing markup and CSS, retain as-is. External design references/anti-references [TBC].

## 4. Invariants
- Local-only preview binds loopback and serves only allowlisted runtime paths; no private masters, repository data, diagnostics DB or credentials.
- Ordinary visitor never loads diagnostics collector or transmits telemetry; explicit loopback diagnostics and consent required.
- Gallery uses derived LOD, detail preserves source geometry and is released on return; evidence must distinguish decoded assets, JS heap, process RSS and GPU memory.
- Existing asset rights restrictions remain; no implied licensing approval from derivatives or local use.
- Current remediation excludes creation, replacement or editing of image assets. Preserve source assets, existing behavior, real DB and dirty worktree; do not blanket-stage or delete.

## 5. Operating constraints
- Constrained-memory mobile/Safari policy exists (1.5 MP cap, reduced reflections/MSAA); normal policy 2.5 MP. Device-specific success requires real measurements, not UA inference.
- Local/no paid services for this scope; hard deadlines [TBC].
- Accessibility target: WCAG AA per Agent Company OS; formal conformance not established. Security and rights requirements documented in P5–P9.

## 6. Owner review
- Running local build, measured regression results and code diff; full public release/individual gate approval belongs to project owner. Additional review format [TBC].
