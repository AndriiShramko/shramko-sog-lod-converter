# Changelog

## 1.1.0 — 2026-10-02

- **Preview and orientation.** After picking a file, a light sample (~0.15% of the splats, read from ~1,000 places across the file; ~2 s for 17.6 GB) is drawn with WebGL2 the way SuperSplat will show it (Y up, ground grid). Turn it with *Auto* (thinnest axis from the sample's covariance; says when unsure of the sign), *Flip upside down*, ±90° turns or exact angles (`splat-transform -r` convention). Optional centring puts the centre at the origin and the ground at 0. The rotation is baked into every level of the archive and remembered per file.
- **Levels for VR headsets and phones.** New default preset *All devices*: levels continue down to ≤ 100K splats (259M → 13 levels, first view 63K splats = 13% of a 0.5M VR budget), adaptive simplification, 256K-splat chunks. *Light* goes to ≤ 50K. *SuperSplat standard* keeps the old ≤ 1M policy. The page shows the first view as a share of a 0.5M VR budget.
- 7 scene presets (All devices, City from a drone, Streets at eye level, Rooms & interiors, Object, Light, SuperSplat standard); max levels raised to 24; time estimate accounts for adaptive simplification.
- Tools: `tools/test-orientation.ts` (Euler parity with the PlayCanvas engine, axis detection with a negative control), `tools/orient-check.mjs` (visual check of the panel), `e2e.mjs --rotate/--centre`, `node-convert.ts --rotate/--decimator`.
- FAQ: rotating a sideways scene; running a 250M-splat city on a VR headset.

## 1.0.0 — 2026-10-02

First release.

- Browser conversion of binary 3DGS PLY (little/big-endian, SH 0–3) into a multi-LOD Streamed SOG `.zip` for SuperSplat, using PlayCanvas splat-transform 3.8.0 in a Web Worker (WebGPU decimation, WebP/SOG encoding in nested workers).
- SuperSplat's LOD policy by default: halve per level until ≤ 1M splats.
- Out-of-core spatial tiling (k-d split planned from sampled positions), in-memory Morton ordering, bounded memory per tab.
- Streaming ZIP64 writer straight to disk (File System Access API), OPFS fallback with download.
- Read-back verification of the finished archive (levels, counts, units, accepted file names).
- Progress with ETA, live log, wake lock, crash marker; visible errors with anonymous error reports; feedback (bug / idea / cooperation).
- 4 languages (EN, ES, PL, RU); static site + tiny Python API in Docker.
