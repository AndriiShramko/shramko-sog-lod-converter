# Changelog

## 1.0.0 — 2026-10-02

First release.

- Browser conversion of binary 3DGS PLY (little/big-endian, SH 0–3) into a multi-LOD Streamed SOG `.zip` for SuperSplat, using PlayCanvas splat-transform 3.8.0 in a Web Worker (WebGPU decimation, WebP/SOG encoding in nested workers).
- SuperSplat's LOD policy by default: halve per level until ≤ 1M splats.
- Out-of-core spatial tiling (k-d split planned from sampled positions), in-memory Morton ordering, bounded memory per tab.
- Streaming ZIP64 writer straight to disk (File System Access API), OPFS fallback with download.
- Read-back verification of the finished archive (levels, counts, units, accepted file names).
- Progress with ETA, live log, wake lock, crash marker; visible errors with anonymous error reports; feedback (bug / idea / cooperation).
- 4 languages (EN, ES, PL, RU); static site + tiny Python API in Docker.
