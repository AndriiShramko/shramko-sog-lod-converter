# AGENTS.md — notes for AI coding agents

Shramko SOG LOD Converter: a static web app that converts giant 3D Gaussian Splatting PLY files into a multi-LOD Streamed SOG `.zip` for SuperSplat, entirely in the browser.

## Map

| Path | What |
|---|---|
| `web/src/engine/pipeline.ts` | The conversion pipeline (platform-neutral: runs in the browser worker and under Node). |
| `web/src/engine/plan.ts` | Settings, LOD planning (`planLevels`), memory/cost model, `previewPlan`. No splat-transform import. |
| `web/src/engine/tiling.ts` / `router.ts` | Position sampling, k-d tiling, one sequential pass per tile group. |
| `web/src/engine/morton.ts` | In-memory Z-order sort of a tile and of decimated levels. |
| `web/src/engine/memory.ts` | Block-based record store and in-memory read/write file systems (no buffer > ~64 MB). |
| `web/src/engine/lod-merge.ts` | Captures each tile's `writeLodSource` output, renames units, joins tile trees. |
| `web/src/engine/zip64.ts` | Streaming ZIP64 writer (stored entries, CRC-32 slicing-by-8). |
| `web/src/engine/verify.ts` | Archive verifier (also used by `tools/verify-zip.ts`). |
| `web/src/engine/worker*.ts`, `protocol.ts` | Browser worker: File input, File System Access / OPFS output, WebGPU device. |
| `web/src/ui/` | Page logic: converter panel, settings, feedback, diagnostics, i18n. |
| `web/template.html`, `web/src/i18n/*.json` | Page template + strings (EN master; ES, PL, RU). `web/scripts/gen-pages.mjs` renders one page per language. |
| `api/` | Python stdlib API: `/api/report`, `/api/lead`, `/api/e`, `/api/health`. |
| `deploy/` | Docker compose, nginx.conf, deploy/rollback scripts, neighbour snapshots. |
| `tools/` | Node harness, verifier, ZIP64 tests, Playwright e2e, screenshots, OG card, reports reader. |

## Rules that matter

- **Pin `@playcanvas/splat-transform` 3.8.0 and `playcanvas` 2.22.6.** `writeLodSource` is marked internal upstream; re-run the e2e before any upgrade.
- **Never allocate one buffer near 2 GB** — Chrome refuses (`Array buffer allocation failed`). Use `RecordStore` blocks.
- **Do not run `npm run build` while an e2e run is serving `dist/`** — Vite empties `dist/` and nested workers lazy-load from it. Use `SOG_OUT=dist-next npm run build`.
- **Every claim "it works" needs the verifier** (`verifyArchive`) on the file read back from disk, plus a negative control (a single-level archive must fail).
- Strings: add keys to `web/src/i18n/en.json` first, then ES/PL/RU; `npm run pages` warns about missing keys.
- The page CSP forbids inline scripts. JSON-LD is fine (not executable).
- Never commit `deploy/hub.env`, `config.env`, `tools/reports/inbox/`.

## Checks before a PR

```bash
npx tsc -p .
python -m unittest discover -s api/tests
npx tsx tools/node-convert.ts sample.ply out.zip --tile-splats 700000 --min-coarsest 200000
npx tsx tools/verify-zip.ts out.zip
node tools/e2e.mjs sample.ply out-e2e.zip --mem 8
```
