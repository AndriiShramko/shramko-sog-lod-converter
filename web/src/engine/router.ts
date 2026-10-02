// One sequential pass over the input PLY that copies the splats of a group of tiles into
// memory, as compact little-endian float32 records holding only the splat properties.

import { keptPropertyNames, type PlyHeader } from './ply-header';
import { RecordStore } from './memory';
import { scalarReader, tileOf, type InputBlob, type KdPlan } from './tiling';

export interface RouteOptions {
    blockBytes?: number;
    onProgress?: (bytesDone: number, bytesTotal: number) => void;
    signal?: { aborted: boolean };
}

/**
 * Read the whole vertex body once and append each splat that falls in one of `tiles` to that
 * tile's store. Returns one store per requested tile (in the same order).
 */
export const routeGroup = async (
    input: InputBlob,
    header: PlyHeader,
    plan: KdPlan,
    tiles: number[],
    opts: RouteOptions = {}
): Promise<RecordStore[]> => {
    const kept = keptPropertyNames(header);
    const K = kept.length;
    const props = kept.map(name => header.properties.find(p => p.name === name)!);
    const px = header.properties.find(p => p.name === 'x')!;
    const py = header.properties.find(p => p.name === 'y')!;
    const pz = header.properties.find(p => p.name === 'z')!;
    const le = header.format === 'binary_little_endian';
    const stride = header.stride;

    const stores = tiles.map(() => new RecordStore(K));
    // tile index → slot in `stores` (-1 when the tile is not in this group)
    const slot = new Int32Array(plan.tileCount).fill(-1);
    tiles.forEach((t, i) => {
        slot[t] = i;
    });

    // Fast path: little-endian, every kept property float32 and 4-byte aligned → Float32Array view.
    const fast = le && stride % 4 === 0 && props.every(p => p.type === 'float32' && p.offset % 4 === 0);
    const strideF = stride / 4;
    const srcF = Int32Array.from(props.map(p => p.offset / 4));
    const readers = props.map(p => scalarReader(p.type, le));
    const rx = scalarReader(px.type, le), ry = scalarReader(py.type, le), rz = scalarReader(pz.type, le);

    const n = header.vertexCount;
    const blockRecords = Math.max(1, Math.floor((opts.blockBytes ?? 32 * 1024 * 1024) / stride));
    const bodyBytes = n * stride;

    let rec = 0;
    // read ahead one block so disk and CPU overlap
    const readBlock = (r0: number) => {
        const r1 = Math.min(n, r0 + blockRecords);
        return input.read(header.bodyOffset + r0 * stride, header.bodyOffset + r1 * stride);
    };
    let pending: Promise<Uint8Array> | null = n > 0 ? readBlock(0) : null;

    while (pending) {
        if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        let bytes = await pending;
        const recs = Math.floor(bytes.byteLength / stride);
        if (recs === 0) throw new Error('The PLY file is shorter than its header says (truncated download or copy?).');
        const nextRec = rec + recs;
        pending = nextRec < n ? readBlock(nextRec) : null;

        if (fast) {
            if (bytes.byteOffset % 4 !== 0) bytes = bytes.slice();
            const f = new Float32Array(bytes.buffer, bytes.byteOffset, (recs * stride) / 4);
            const ox = px.offset / 4, oy = py.offset / 4, oz = pz.offset / 4;
            for (let r = 0, base = 0; r < recs; r++, base += strideF) {
                const t = tileOf(plan, f[base + ox], f[base + oy], f[base + oz]);
                const s = slot[t];
                if (s < 0) continue;
                const st = stores[s];
                const offset = st.reserve();
                const block = st.block;
                for (let k = 0; k < K; k++) block[offset + k] = f[base + srcF[k]];
            }
        } else {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let r = 0, base = 0; r < recs; r++, base += stride) {
                const t = tileOf(plan, rx(view, base + px.offset), ry(view, base + py.offset), rz(view, base + pz.offset));
                const s = slot[t];
                if (s < 0) continue;
                const st = stores[s];
                const offset = st.reserve();
                const block = st.block;
                for (let k = 0; k < K; k++) block[offset + k] = readers[k](view, base + props[k].offset);
            }
        }

        rec = nextRec;
        opts.onProgress?.(rec * stride, bodyBytes);
    }

    if (rec !== n) {
        throw new Error(`Read ${rec} splats but the header declares ${n}. The file may be truncated.`);
    }
    return stores;
};
