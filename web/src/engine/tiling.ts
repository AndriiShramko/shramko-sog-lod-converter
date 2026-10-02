// Spatial tiling of a huge scene.
//
// The browser cannot hold a scene of hundreds of millions of splats at once (each typed array
// is capped near 2 GiB, the whole tab near 16 GiB). So the scene is cut into axis-aligned tiles
// of a bounded size with a k-d split planned from a sample of positions; each tile is then
// converted on its own and the tiles' LOD trees are joined under the same k-d split.

import { type PlyHeader, type PlyScalarType } from './ply-header';

/** Random-access byte reader over the input file. */
export interface InputBlob {
    readonly size: number;
    read(start: number, end: number): Promise<Uint8Array>;
}

export interface KdPlan {
    // node arrays; node 0 is the root
    axis: Int8Array;        // -1 for leaves
    split: Float64Array;    // split value (points with v < split go left)
    left: Int32Array;
    right: Int32Array;
    tile: Int32Array;       // leaf → tile index (-1 for internal nodes)
    tileCount: number;
    estimates: number[];    // estimated splats per tile
}

type Reader = (view: DataView, offset: number) => number;

/** Build a fast per-property decoder for one scalar type + byte order. */
export const scalarReader = (type: PlyScalarType, littleEndian: boolean): Reader => {
    switch (type) {
        case 'float32': return (v, o) => v.getFloat32(o, littleEndian);
        case 'float64': return (v, o) => v.getFloat64(o, littleEndian);
        case 'int8': return (v, o) => v.getInt8(o);
        case 'uint8': return (v, o) => v.getUint8(o);
        case 'int16': return (v, o) => v.getInt16(o, littleEndian);
        case 'uint16': return (v, o) => v.getUint16(o, littleEndian);
        case 'int32': return (v, o) => v.getInt32(o, littleEndian);
        case 'uint32': return (v, o) => v.getUint32(o, littleEndian);
    }
};

/**
 * Sample splat positions spread evenly through the file by reading small blocks at regular
 * intervals. Far cheaper than a full pass (a few hundred MB instead of the whole file), and the
 * tiling only needs approximate densities: the router later counts every splat exactly.
 */
export const samplePositions = async (
    input: InputBlob,
    header: PlyHeader,
    opts: { blocks: number; blockRecords: number; onProgress?: (fraction: number) => void; signal?: { aborted: boolean } }
): Promise<{ xyz: Float32Array; count: number; recordsSampled: number }> => {
    const n = header.vertexCount;
    const stride = header.stride;
    const blocks = Math.max(1, Math.min(opts.blocks, Math.ceil(n / opts.blockRecords)));
    const perBlock = Math.min(opts.blockRecords, n);
    const xyz = new Float32Array(blocks * perBlock * 3);
    const le = header.format === 'binary_little_endian';
    const px = header.properties.find(p => p.name === 'x')!;
    const py = header.properties.find(p => p.name === 'y')!;
    const pz = header.properties.find(p => p.name === 'z')!;
    const rx = scalarReader(px.type, le), ry = scalarReader(py.type, le), rz = scalarReader(pz.type, le);

    let count = 0;
    let sampled = 0;
    for (let b = 0; b < blocks; b++) {
        if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        // spread block starts evenly over the record range
        const startRec = Math.floor((b / blocks) * Math.max(0, n - perBlock));
        const start = header.bodyOffset + startRec * stride;
        const bytes = await input.read(start, start + perBlock * stride);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const recs = Math.floor(bytes.byteLength / stride);
        for (let r = 0; r < recs; r++) {
            const o = r * stride;
            const x = rx(view, o + px.offset), y = ry(view, o + py.offset), z = rz(view, o + pz.offset);
            sampled++;
            if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                xyz[count * 3] = x;
                xyz[count * 3 + 1] = y;
                xyz[count * 3 + 2] = z;
                count++;
            }
        }
        opts.onProgress?.((b + 1) / blocks);
    }
    return { xyz, count, recordsSampled: sampled };
};

/**
 * Plan a k-d tiling so that every tile is expected to hold at most `maxPerTile` splats.
 * @param xyz - Sampled positions.
 * @param count - Number of samples in `xyz`.
 * @param total - Total splats in the scene (samples are scaled up to this).
 */
export const planTiles = (xyz: Float32Array, count: number, total: number, maxPerTile: number): KdPlan => {
    const axis: number[] = [];
    const split: number[] = [];
    const left: number[] = [];
    const right: number[] = [];
    const tile: number[] = [];
    const estimates: number[] = [];
    const scale = count > 0 ? total / count : 0;

    const idx = new Uint32Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;

    const newNode = () => {
        axis.push(-1); split.push(0); left.push(-1); right.push(-1); tile.push(-1);
        return axis.length - 1;
    };

    // quickselect on idx[lo..hi) by coordinate `a`, placing the k-th smallest at position k
    const select = (lo: number, hi: number, k: number, a: number) => {
        let l = lo, r = hi - 1;
        while (l < r) {
            const pivot = xyz[idx[(l + r) >> 1] * 3 + a];
            let i = l, j = r;
            while (i <= j) {
                while (xyz[idx[i] * 3 + a] < pivot) i++;
                while (xyz[idx[j] * 3 + a] > pivot) j--;
                if (i <= j) {
                    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
                    i++; j--;
                }
            }
            if (k <= j) r = j; else if (k >= i) l = i; else break;
        }
    };

    const build = (lo: number, hi: number, depth: number): number => {
        const node = newNode();
        const n = hi - lo;
        const est = n * scale;
        if (est <= maxPerTile || n < 2 || depth > 40) {
            tile[node] = estimates.length;
            estimates.push(Math.round(est));
            return node;
        }
        // split the widest axis of this node's samples at the median
        let bestA = 0, bestExt = -1;
        for (let a = 0; a < 3; a++) {
            let mn = Infinity, mx = -Infinity;
            for (let i = lo; i < hi; i++) {
                const v = xyz[idx[i] * 3 + a];
                if (v < mn) mn = v;
                if (v > mx) mx = v;
            }
            if (mx - mn > bestExt) {
                bestExt = mx - mn;
                bestA = a;
            }
        }
        if (bestExt <= 0) {
            // all samples coincide: cannot split spatially, keep as one tile
            tile[node] = estimates.length;
            estimates.push(Math.round(est));
            return node;
        }
        const mid = (lo + hi) >> 1;
        select(lo, hi, mid, bestA);
        const value = xyz[idx[mid] * 3 + bestA];
        let splitValue = value;
        // move every sample equal to the split value to the right side
        let m = lo;
        for (let i = lo; i < hi; i++) {
            if (xyz[idx[i] * 3 + bestA] < value) {
                const t = idx[i]; idx[i] = idx[m]; idx[m] = t; m++;
            }
        }
        if (m === lo) {
            // the median equals the minimum (many identical values): put the ties left instead
            for (let i = lo; i < hi; i++) {
                if (xyz[idx[i] * 3 + bestA] <= value) {
                    const t = idx[i]; idx[i] = idx[m]; idx[m] = t; m++;
                }
            }
            // a split strictly above `value` but below the next float32, so "v < split" sends ties left
            splitValue = value + Math.abs(value) * 2 ** -26 + Number.MIN_VALUE;
        }
        if (m === lo || m === hi) {
            tile[node] = estimates.length;
            estimates.push(Math.round(est));
            return node;
        }
        axis[node] = bestA;
        split[node] = splitValue;
        const l = build(lo, m, depth + 1);
        const r = build(m, hi, depth + 1);
        left[node] = l;
        right[node] = r;
        return node;
    };

    build(0, count, 0);

    return {
        axis: Int8Array.from(axis),
        split: Float64Array.from(split),
        left: Int32Array.from(left),
        right: Int32Array.from(right),
        tile: Int32Array.from(tile),
        tileCount: estimates.length,
        estimates
    };
};

/** Which tile a position belongs to. Non-finite coordinates end up in some tile; filterNaN removes them later. */
export const tileOf = (plan: KdPlan, x: number, y: number, z: number): number => {
    let node = 0;
    const { axis, split, left, right } = plan;
    while (axis[node] >= 0) {
        const a = axis[node];
        const v = a === 0 ? x : a === 1 ? y : z;
        node = v < split[node] ? left[node] : right[node];
    }
    return plan.tile[node];
};

/**
 * Group consecutive tiles (k-d order = spatial neighbours) so each group's raw records fit in
 * `budgetBytes`. Each group costs one sequential pass over the input file.
 */
export const groupTiles = (estimates: number[], bytesPerSplat: number, budgetBytes: number): number[][] => {
    const groups: number[][] = [];
    let cur: number[] = [];
    let curBytes = 0;
    estimates.forEach((est, t) => {
        const b = est * bytesPerSplat;
        if (cur.length > 0 && curBytes + b > budgetBytes) {
            groups.push(cur);
            cur = [];
            curBytes = 0;
        }
        cur.push(t);
        curBytes += b;
    });
    if (cur.length > 0) groups.push(cur);
    return groups;
};
