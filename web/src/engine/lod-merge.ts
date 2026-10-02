// Joins the per-tile Streamed SOG outputs into one archive and one lod-meta.json.
//
// splat-transform's LOD writer runs once per tile. Its files are intercepted here: the tile's
// lod-meta.json is parsed (it is written before any unit), every unit folder "<lod>_<i>" is
// renamed to a scene-wide "<lod>_<n>", and the unit files stream straight into the zip.
// At the end the tile trees are hung under the same k-d split that made the tiles.

import type { FileSystem, Writer } from '@playcanvas/splat-transform';
import type { KdPlan } from './tiling';
import type { ZipWriter } from './zip64';

export type Bound = { min: [number, number, number]; max: [number, number, number] };
export type LodRef = { file: number; offset: number; count: number };
export type LodNode = { bound: Bound; children?: LodNode[]; lods?: Record<string, LodRef> };

export interface LodMeta {
    version: number;
    asset?: Record<string, unknown>;
    count: number;
    counts: number[];
    lodLevels: number;
    environment?: string | null;
    filenames: string[];
    tree: LodNode;
}

/** Files a Streamed SOG unit may contain (the same list superspl.at's upload check allows). */
export const UNIT_FILES = new Set([
    'meta.json', 'means_l.webp', 'means_u.webp', 'scales.webp', 'quats.webp', 'sh0.webp', 'shN_labels.webp', 'shN_centroids.webp'
]);

export class LodMerger {
    readonly zip: ZipWriter;
    readonly filenames: string[] = [];
    private nextUnit: number[] = [];       // per lod: next scene-wide unit number
    private tileTrees = new Map<number, LodNode>();
    private tileCounts = new Map<number, number[]>();
    lodLevels = 0;
    bytesOfUnits = 0;

    constructor(zip: ZipWriter) {
        this.zip = zip;
    }

    /**
     * A FileSystem for one tile's writeLodSource call. `prefix` is the directory the writer was
     * pointed at (e.g. "/out/").
     */
    tileFs(tile: number, prefix: string): FileSystem & { done(): void } {
        // tile-local unit dir ("0_3") → scene-wide dir ("0_17")
        const dirMap = new Map<string, string>();
        // tile-local filenames index → scene-wide filenames index
        let indexMap: number[] = [];
        let tileMeta: LodMeta | null = null;
        const merger = this;

        const rel = (path: string) => {
            if (!path.startsWith(prefix)) throw new Error(`internal: unexpected output path ${path}`);
            return path.substring(prefix.length);
        };

        const onMeta = (bytes: Uint8Array) => {
            const meta = JSON.parse(new TextDecoder().decode(bytes)) as LodMeta;
            if (meta.environment) throw new Error('internal: tiles must not have an environment');
            tileMeta = meta;
            if (merger.lodLevels === 0) merger.lodLevels = meta.lodLevels;
            if (meta.lodLevels !== merger.lodLevels) {
                throw new Error(`internal: tile ${tile} has ${meta.lodLevels} LOD levels, expected ${merger.lodLevels}`);
            }
            indexMap = meta.filenames.map((f) => {
                const m = /^(\d+)_(\d+)\/meta\.json$/.exec(f);
                if (!m) throw new Error(`internal: unexpected unit file name ${f}`);
                const lod = parseInt(m[1], 10);
                while (merger.nextUnit.length <= lod) merger.nextUnit.push(0);
                const sceneDir = `${lod}_${merger.nextUnit[lod]++}`;
                dirMap.set(`${m[1]}_${m[2]}`, sceneDir);
                merger.filenames.push(`${sceneDir}/meta.json`);
                return merger.filenames.length - 1;
            });
            merger.tileCounts.set(tile, meta.counts.slice());
        };

        const fs: FileSystem & { done(): void } = {
            createWriter(filename: string): Writer {
                const r = rel(filename);
                const chunks: Uint8Array[] = [];
                let bytes = 0;
                let target: string | null = null;
                if (r !== 'lod-meta.json') {
                    const slash = r.indexOf('/');
                    const dir = r.substring(0, slash);
                    const file = r.substring(slash + 1);
                    const sceneDir = dirMap.get(dir);
                    if (!sceneDir) throw new Error(`internal: unit ${dir} was not listed in the tile's lod-meta.json`);
                    if (!UNIT_FILES.has(file)) throw new Error(`internal: unexpected unit file ${file}`);
                    target = `${sceneDir}/${file}`;
                }
                return {
                    get bytesWritten() {
                        return bytes;
                    },
                    write(data: Uint8Array) {
                        chunks.push(data.slice());
                        bytes += data.byteLength;
                    },
                    async close() {
                        const all = chunks.length === 1 ? chunks[0] : concat(chunks, bytes);
                        if (target === null) {
                            onMeta(all);
                        } else {
                            merger.bytesOfUnits += all.byteLength;
                            await merger.zip.add(target, all);
                        }
                    },
                    abort() {
                        chunks.length = 0;
                    }
                };
            },
            mkdir(): Promise<void> {
                return Promise.resolve();
            },
            done() {
                if (!tileMeta) throw new Error(`internal: tile ${tile} produced no lod-meta.json`);
                merger.tileTrees.set(tile, remapTree(tileMeta.tree, indexMap));
            }
        };
        return fs;
    }

    /** Per-level splat counts summed over finished tiles. */
    get counts(): number[] {
        const out = new Array(this.lodLevels).fill(0);
        for (const c of this.tileCounts.values()) c.forEach((v, i) => {
            out[i] += v;
        });
        return out;
    }

    /** Build the scene lod-meta.json, joining tile trees along the k-d split. */
    buildMeta(plan: KdPlan, asset: Record<string, unknown>): LodMeta {
        const join = (node: number): LodNode | null => {
            if (plan.axis[node] < 0) return this.tileTrees.get(plan.tile[node]) ?? null;
            const l = join(plan.left[node]);
            const r = join(plan.right[node]);
            if (!l) return r;
            if (!r) return l;
            return { bound: union(l.bound, r.bound), children: [l, r] };
        };
        const tree = join(0);
        if (!tree) throw new Error('No splats were written (every tile was empty).');
        const counts = this.counts;
        return {
            version: 1,
            asset,
            count: counts.reduce((a, b) => a + b, 0),
            counts,
            lodLevels: this.lodLevels,
            filenames: this.filenames,
            tree
        };
    }
}

const concat = (chunks: Uint8Array[], total: number): Uint8Array => {
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.byteLength;
    }
    return out;
};

const remapTree = (node: LodNode, indexMap: number[]): LodNode => {
    if (node.children) {
        return { bound: node.bound, children: node.children.map(c => remapTree(c, indexMap)) };
    }
    const lods: Record<string, LodRef> = {};
    for (const [k, ref] of Object.entries(node.lods ?? {})) {
        const file = indexMap[ref.file];
        if (file === undefined) throw new Error(`internal: tile tree references unknown file ${ref.file}`);
        lods[k] = { file, offset: ref.offset, count: ref.count };
    }
    return { bound: node.bound, lods };
};

const union = (a: Bound, b: Bound): Bound => ({
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])]
});

/** Same number formatting splat-transform uses in lod-meta.json (7 significant digits). */
export const serializeMeta = (meta: LodMeta): Uint8Array => {
    const json = JSON.stringify(meta, (_key, value) => {
        if (typeof value === 'number' && !Number.isInteger(value)) return parseFloat(value.toPrecision(7));
        return value;
    });
    return new TextEncoder().encode(json);
};
