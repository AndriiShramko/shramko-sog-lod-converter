---
name: shramko-sog-lod-converter
description: Prepare a large 3D Gaussian Splatting PLY for SuperSplat — build a Streamed SOG .zip with real levels of detail (LOD) and SOG compression, verify it, and upload it. Use when a user says "my PLY is over 10 GB", "make streamed SOG / SSOG", "build LODs for my splat", "lod-meta.json", "upload a huge scan to superspl.at", or "why does my streamed SOG have no LOD".
---

# Streamed SOG with real LODs for SuperSplat

## Decide

- Scene ≤ 1M splats → a single level is fine; a plain `.sog` or the PLY itself also works on superspl.at.
- PLY ≤ 10 GB and the user is happy with SuperSplat's own server-side LODs → upload the PLY with "Auto generate LODs".
- PLY > 10 GB, or the user wants control / to keep the LODs elsewhere → convert here.

## Convert

Interactive: open <https://sog.flyreelstudio.eu> (desktop Chrome/Edge), drop the PLY, keep defaults, Convert, save `<name>-SSOG.zip`.

Headless: `npx tsx tools/node-convert.ts input.ply output.zip` in a clone of <https://github.com/AndriiShramko/shramko-sog-lod-converter>.

Defaults = SuperSplat policy: each level keeps 50% of the previous until ≤ 1,000,000 splats (`1 + ⌈log₂(N/1M)⌉` levels); chunks 512K splats / 16 world units / min 8K.

## Verify (always, before saying "done")

`npx tsx tools/verify-zip.ts output.zip` must exit 0: `lod-meta.json` at the root, `lodLevels` > 1 for scenes over 1M splats, counts decreasing, every unit and WebP present, only file names superspl.at accepts.

## Upload

superspl.at → Upload → drop the `.zip` (≤ 10 GB). It is published with the levels as built.

## Pitfalls

- `splat-transform scene.ply out/lod-meta.json` alone produces ONE level (no LODs). Levels must be decimated and tagged (`-l 0..n`).
- Archives over 4 GB are ZIP64 (supported by superspl.at's reader).
- Browser memory: ~16 GB per tab; lower "RAM to use" on smaller machines.
