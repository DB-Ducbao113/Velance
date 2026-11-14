# V6 image asset contract

Each supported car has exactly five **static** transparent image assets. No canvas or video is used in these sections.

## Directory structure

```
assets/images/
  mclarenp1/
    01-front-three-quarter.webp
    02-near-front.webp
    03-side-profile.webp
    04-rear-three-quarter.webp
    05-signature.webp
  laferrari/
    ... the same five filenames ...
  jesko23/ jesko25/ tourbillon24/ tourbillon26/ paganiutopia/ amgone/
    ... the same five filenames ...
```

Render masters from the actual reviewed GLB using one consistent environment and paint color, export lossless 4K RGBA PNG, then web-optimized WebP with alpha (2048–4096 px width). Do NOT bake a black/white studio backdrop, shadow card, checkerboard or gradient into any image. The website supplies its own background and layout.

Missing images are expected in the V6 source-only archive and show numbered placeholders. The site attempts to load them automatically when a car is selected; once you copy the filenames above, the placeholders are replaced without editing code.
