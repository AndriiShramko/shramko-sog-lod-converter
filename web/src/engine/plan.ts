// Settings, LOD planning and the cost/memory model. No splat-transform imports here, so the
// page can preview a plan without loading the converter.

import { keptPropertyNames, type PlyHeader } from './ply-header';

export const CONVERTER_VERSION = '1.0.0';

export interface ConvertSettings {
    /** Fraction of splats each coarser level keeps (SuperSplat: 0.5). */
    lodRatio: number;
    /** Stop adding levels once a level holds at most this many splats (SuperSplat: 1,000,000). */
    minCoarsest: number;
    /** Upper bound on the number of levels (0 = no extra cap beyond 16). */
    maxLevels: number;
    decimator: 'uniform' | 'adaptive';
    filterNaN: boolean;
    /** Keep at most this many SH bands; -1 keeps what the file has. */
    shBands: -1 | 0 | 1 | 2 | 3;
    /** SH k-means iterations (only matters with SH bands > 0). */
    iterations: number;
    /** Lossless WebP effort 0–9, or null for libwebp's default. */
    webpEffort: number | null;
    /** LOD chunking (K splats / world units / K splats) — SuperSplat uses 512 / 16 / 8. */
    chunkCount: number;
    chunkExtent: number;
    chunkMin: number;
    /** RAM the converter may use, in bytes. */
    memoryBytes: number;
    /** Splats per tile; 0 = derive from memoryBytes. */
    tileSplats: number;
    /**
     * Rotation applied to the whole scene, as Euler angles in degrees in the PlayCanvas engine's
     * space (the space SuperSplat shows: Y is up). Same convention as splat-transform's `-r x,y,z`.
     * Scans differ — this is chosen per file in the preview, never assumed.
     */
    rotation: [number, number, number];
    /** Translation applied after the rotation (engine space), e.g. to centre the scene. */
    translation: [number, number, number];
}

export const DEFAULT_SETTINGS: ConvertSettings = {
    lodRatio: 0.5,
    minCoarsest: 100_000,
    maxLevels: 0,
    decimator: 'adaptive',
    filterNaN: true,
    shBands: -1,
    iterations: 10,
    webpEffort: null,
    chunkCount: 256,
    chunkExtent: 16,
    chunkMin: 16,
    memoryBytes: 8 * 1024 ** 3,
    tileSplats: 0,
    rotation: [0, 0, 0],
    translation: [0, 0, 0]
};

export type Stage = 'header' | 'sample' | 'read' | 'decimate' | 'encode' | 'finalize' | 'verify' | 'done';

export interface PlanInfo {
    splats: number;
    fileBytes: number;
    shBands: number;
    keptShBands: number;
    properties: string[];
    droppedProperties: string[];
    levels: number[];            // planned per-level counts for the whole scene
    tiles: number;
    passes: number;
    tileSplats: number;
    estimatedSeconds: number;
    estimatedOutputBytes: number;
}

// Rough cost model (seconds per splat), calibrated live as tiles finish. Initial values were
// measured with splat-transform 3.8.0 on an i9-7980XE / RTX 4090 (20M-splat sample).
export const INITIAL = { readBps: 300e6, decimatePerSplat: 7.5e-6, encodePerSplat: 6.7e-6 };

/** Adaptive decimation is ~2.4× slower than uniform (measured: 20M → 10M, 5 min 59 s vs 2 min 29 s). */
export const decimatorFactor = (s: Pick<ConvertSettings, 'decimator'>) => (s.decimator === 'adaptive' ? 2.4 : 1);

/** Plan the per-level splat counts for a scene of `n` splats. */
export const planLevels = (n: number, s: Pick<ConvertSettings, 'lodRatio' | 'minCoarsest' | 'maxLevels'>): number[] => {
    const cap = s.maxLevels > 0 ? Math.min(24, s.maxLevels) : 24;
    const out = [n];
    let c = n;
    while (c > s.minCoarsest && out.length < cap) {
        c = Math.max(1, Math.round(c * s.lodRatio));
        out.push(c);
    }
    return out;
};

/** Approximate peak bytes per splat while one tile is converted. */
export const workBytesPerSplat = (keptFloats: number, s: ConvertSettings) => {
    const record = keptFloats * 4;
    const decimate = s.decimator === 'adaptive' ? 130 : 110; // measured peaks: 1.97 vs 2.15 GB for 20M (Node)
    return record /* level 0 */ + record /* coarser levels, sum ≈ 1× */ + decimate + 60 /* LOD writer */;
};

export const tileSize = (keptFloats: number, s: ConvertSettings) => (s.tileSplats > 0 ? s.tileSplats :
    Math.max(1_000_000, Math.min(40_000_000, Math.floor((0.4 * s.memoryBytes) / workBytesPerSplat(keptFloats, s)))));

export const groupBytes = (keptFloats: number, tile: number, s: ConvertSettings) => Math.max(0.35 * s.memoryBytes, tile * keptFloats * 4 * 1.3);

/** Archive bytes per splat (all levels): measured 11.8–12.2 B for SH0 scans; SH adds palette labels. */
export const outBytesPerSplat = (shBands: number) => 12.2 + (shBands > 0 ? 4 : 0);

/** What the UI shows right after a file is picked (header only, before any sampling). */
export const previewPlan = (header: PlyHeader, fileBytes: number, s: ConvertSettings, gpu: boolean): PlanInfo => {
    const kept = keptPropertyNames(header);
    const keptSh = s.shBands < 0 ? header.shBands : Math.min(header.shBands, s.shBands);
    const levels = planLevels(header.vertexCount, s);
    const tile = tileSize(kept.length, s);
    const tiles = Math.max(1, Math.ceil(header.vertexCount / tile));
    const passes = Math.max(1, Math.ceil((header.vertexCount * kept.length * 4) / groupBytes(kept.length, tile, s)));
    const decIn = levels.slice(0, -1).reduce((a, b) => a + b, 0);
    const enc = levels.reduce((a, b) => a + b, 0);
    const decPer = (gpu ? INITIAL.decimatePerSplat : INITIAL.decimatePerSplat * 4) * decimatorFactor(s);
    return {
        splats: header.vertexCount,
        fileBytes,
        shBands: header.shBands,
        keptShBands: keptSh,
        properties: kept,
        droppedProperties: header.extraProperties,
        levels,
        tiles,
        passes,
        tileSplats: tile,
        estimatedSeconds: passes * (header.vertexCount * header.stride) / INITIAL.readBps + decIn * decPer + enc * INITIAL.encodePerSplat,
        estimatedOutputBytes: Math.round(enc * outBytesPerSplat(keptSh))
    };
};
