// Sampling a giant PLY for the preview: a few hundred thousand visible splats from blocks spread
// across the file. No DOM here (also used by the Node tests).

import type { PlyHeader } from '../engine/ply-header';
import { scalarReader } from '../engine/tiling';

export interface PreviewSample {
    raw: Float32Array;   // x, y, z per point (file coordinates)
    color: Uint8Array;   // r, g, b per point
    count: number;
    total: number;       // splats in the file
}

const SH_C0 = 0.28209479177387814;

/** Sample `target` visible splats spread evenly through the file. */
export const samplePreview = async (
    file: Blob,
    header: PlyHeader,
    target: number,
    onProgress?: (f: number) => void
): Promise<PreviewSample> => {
    const n = header.vertexCount;
    const stride = header.stride;
    const le = header.format === 'binary_little_endian';
    const prop = (name: string) => header.properties.find(p => p.name === name)!;
    const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'];
    const props = names.map(prop);
    const readers = props.map(p => scalarReader(p.type, le));
    const blocks = Math.min(1024, Math.max(16, Math.ceil(n / 50_000)));
    // read ~3× the target: faint splats and floaters (often half the file) are skipped
    const perBlock = Math.max(32, Math.min(n, Math.ceil((target * 3) / blocks)));
    const raw = new Float32Array(target * 3);
    const color = new Uint8Array(target * 3);
    let count = 0;
    for (let b = 0; b < blocks && count < target; b++) {
        const startRec = Math.floor((b / blocks) * Math.max(0, n - perBlock));
        const start = header.bodyOffset + startRec * stride;
        const bytes = new Uint8Array(await file.slice(start, start + perBlock * stride).arrayBuffer());
        const v = new DataView(bytes.buffer);
        const recs = Math.floor(bytes.byteLength / stride);
        for (let r = 0; r < recs && count < target; r++) {
            const o = r * stride;
            const vals = readers.map((rd, k) => rd(v, o + props[k].offset));
            const [x, y, z, c0, c1, c2, op] = vals;
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            if (1 / (1 + Math.exp(-op)) < 0.35) continue; // skip faint splats and floaters
            raw[count * 3] = x; raw[count * 3 + 1] = y; raw[count * 3 + 2] = z;
            color[count * 3] = Math.max(0, Math.min(255, (0.5 + SH_C0 * c0) * 255));
            color[count * 3 + 1] = Math.max(0, Math.min(255, (0.5 + SH_C0 * c1) * 255));
            color[count * 3 + 2] = Math.max(0, Math.min(255, (0.5 + SH_C0 * c2) * 255));
            count++;
        }
        onProgress?.((b + 1) / blocks);
    }
    return { raw: raw.subarray(0, count * 3), color: color.subarray(0, count * 3), count, total: n };
};
