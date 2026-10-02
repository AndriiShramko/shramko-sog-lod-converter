// Scene presets. Each one sets only what the FILE controls; budgets, LOD distances and
// penalties live in the viewer (PlayCanvas engine / SuperSplat) and cannot be set here.
//
// Evidence (2026-10-02, playcanvas 2.22.6 + splat-transform 3.8.0, measured on a 259M-splat city scan
// and simulated with the engine's own LOD classes on public superspl.at manifests):
// - The coarsest level is a FLOOR: the viewer never draws fewer splats than its total, and
//   SuperSplat downloads all of it before the first frame. Phones / VR headsets get a 1M budget,
//   so a floor of 0.5–1M leaves them almost no room to refine. → lower `minCoarsest`.
// - One unit file is downloaded whole: smaller `chunkCount` cuts resident data (−58 % at 128K
//   vs 512K) at the cost of more files; with SH each unit also carries a palette, so stay ≥ 256K.
// - In dense aerial scans `chunkExtent`/`chunkMin` set the node count: 32 m / 32K gives 4× fewer
//   nodes (31 → 7.9 MB manifest, ~5× cheaper LOD pass) with identical views, fly-down included.
// - At eye level 16 m nodes measured best (8 m: no gain, 3× nodes; 32 m: coarser near field).
// - `lodRatio` stays 0.5: 0.6 was worse everywhere (+25 % data), 0.4's visual quality is unmeasured.
// - splat-transform's own notes: adaptive decimation wins on mixed-scale content (skies), uniform
//   on single objects and uniform texture. Measured here: LOD 2 (25 % of the splats) rendered
//   against the source from the same camera — adaptive 34.4 dB vs uniform 28.0 dB PSNR.

import type { ConvertSettings } from './plan';

export type PresetId = 'standard' | 'interior' | 'street' | 'aerial' | 'light' | 'object';

export type PresetValues = Pick<ConvertSettings, 'lodRatio' | 'minCoarsest' | 'maxLevels' | 'decimator' | 'shBands' | 'chunkCount' | 'chunkExtent' | 'chunkMin'>;

export const PRESETS: Record<PresetId, PresetValues> = {
    // parity with what superspl.at builds itself (549/549 public multi-LOD scenes: 0.5, 512/16/8)
    standard: { lodRatio: 0.5, minCoarsest: 1_000_000, maxLevels: 0, decimator: 'uniform', shBands: -1, chunkCount: 512, chunkExtent: 16, chunkMin: 8 },
    // rooms are 4–8 m: finer nodes so LOD can change per room; floor ≤ half of a phone budget
    interior: { lodRatio: 0.5, minCoarsest: 500_000, maxLevels: 0, decimator: 'adaptive', shBands: -1, chunkCount: 256, chunkExtent: 8, chunkMin: 4 },
    // eye level: 16 m nodes measured best; skies and facades are mixed-scale → adaptive
    street: { lodRatio: 0.5, minCoarsest: 500_000, maxLevels: 0, decimator: 'adaptive', shBands: -1, chunkCount: 256, chunkExtent: 16, chunkMin: 8 },
    // whole city in view from above: light first frame, 4× fewer nodes, no SH (−37 % bytes)
    aerial: { lodRatio: 0.5, minCoarsest: 250_000, maxLevels: 0, decimator: 'adaptive', shBands: 0, chunkCount: 256, chunkExtent: 32, chunkMin: 32 },
    // weak devices first: lowest floor, smallest downloads, no SH
    light: { lodRatio: 0.5, minCoarsest: 250_000, maxLevels: 0, decimator: 'adaptive', shBands: 0, chunkCount: 128, chunkExtent: 16, chunkMin: 8 },
    // a single object or small scan: keep view-dependent colour, uniform decimation
    object: { lodRatio: 0.5, minCoarsest: 500_000, maxLevels: 0, decimator: 'uniform', shBands: -1, chunkCount: 256, chunkExtent: 16, chunkMin: 8 }
};

export const PRESET_ORDER: PresetId[] = ['standard', 'aerial', 'street', 'interior', 'object', 'light'];

/** Which preset (if any) the given settings match exactly. */
export const matchPreset = (s: PresetValues): PresetId | 'custom' => {
    for (const id of PRESET_ORDER) {
        const p = PRESETS[id];
        if ((Object.keys(p) as (keyof PresetValues)[]).every(k => p[k] === s[k])) return id;
    }
    return 'custom';
};

/** Splat budgets of common viewers (SuperSplat viewer.ts, 2026-10-02). */
export const VIEWER_BUDGETS = { phoneOrVr: 1_000_000, desktopLow: 2_000_000, desktopHigh: 4_000_000 };
