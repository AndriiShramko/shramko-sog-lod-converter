// Physical Morton (Z-order) reordering of a tile's records.
//
// Scans come out of training in an order that is only weakly spatial, and splat-transform's
// decimator and LOD writer read their input by spatial blocks: on scattered input every block
// turns into thousands of tiny reads ("input is spatially incoherent"). Reordering each level's
// records along a Z-order curve once, in memory, makes those reads contiguous.

import { parsePlyHeader } from './ply-header';
import { RecordStore } from './memory';

/** Morton codes (10 bits per axis) for n points; returns codes and a sorted permutation. */
const mortonOrder = (n: number, getX: (i: number) => number, getY: (i: number) => number, getZ: (i: number) => number): Uint32Array => {
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < n; i++) {
        const x = getX(i), y = getY(i), z = getZ(i);
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    const sx = mxx > mnx ? 1023.999 / (mxx - mnx) : 0;
    const sy = mxy > mny ? 1023.999 / (mxy - mny) : 0;
    const sz = mxz > mnz ? 1023.999 / (mxz - mnz) : 0;
    const spread = (v: number) => {
        v &= 0x3ff;
        v = (v | (v << 16)) & 0x030000ff;
        v = (v | (v << 8)) & 0x0300f00f;
        v = (v | (v << 4)) & 0x030c30c3;
        v = (v | (v << 2)) & 0x09249249;
        return v;
    };
    const codes = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        // non-finite coordinates (filtered later) sort to code 0
        const qx = Number.isFinite(getX(i)) ? Math.floor((getX(i) - mnx) * sx) : 0;
        const qy = Number.isFinite(getY(i)) ? Math.floor((getY(i) - mny) * sy) : 0;
        const qz = Number.isFinite(getZ(i)) ? Math.floor((getZ(i) - mnz) * sz) : 0;
        codes[i] = (spread(qx) | (spread(qy) << 1) | (spread(qz) << 2)) >>> 0;
    }
    // LSD radix sort of indices by code, 3 passes of 10 bits
    let idx = new Uint32Array(n);
    let tmp = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    const counts = new Uint32Array(1024);
    for (let shift = 0; shift < 30; shift += 10) {
        counts.fill(0);
        for (let i = 0; i < n; i++) counts[(codes[idx[i]] >>> shift) & 1023]++;
        let sum = 0;
        for (let b = 0; b < 1024; b++) {
            const c = counts[b];
            counts[b] = sum;
            sum += c;
        }
        for (let i = 0; i < n; i++) {
            const v = idx[i];
            tmp[counts[(codes[v] >>> shift) & 1023]++] = v;
        }
        const t = idx; idx = tmp; tmp = t;
    }
    return idx;
};

/** Reorder a float32 record store by Morton order of the floats at offsets ix/iy/iz. */
export const mortonReorderStore = (store: RecordStore, ix = 0, iy = 1, iz = 2): RecordStore => {
    const n = store.count;
    const K = store.floatsPerRecord;
    const per = store.recordsPerBlock;
    const blocks = store.segments().map(s => new Float32Array(s.buffer, s.byteOffset, s.byteLength / 4));
    const at = (i: number, k: number) => blocks[Math.floor(i / per)][(i % per) * K + k];
    const order = mortonOrder(n, i => at(i, ix), i => at(i, iy), i => at(i, iz));
    const out = new RecordStore(K);
    for (let j = 0; j < n; j++) {
        const i = order[j];
        const src = blocks[Math.floor(i / per)];
        const so = (i % per) * K;
        const o = out.reserve();
        const dst = out.block;
        for (let k = 0; k < K; k++) dst[o + k] = src[so + k];
    }
    return out;
};

/**
 * Reorder an in-memory float32 little-endian PLY (as written by splat-transform) by Morton
 * order. Returns the new file as segments [header, ...blocks].
 */
export const mortonReorderPly = (segments: Uint8Array[]): Uint8Array[] => {
    const total = segments.reduce((a, s) => a + s.byteLength, 0);
    const headBytes = concatPrefix(segments, Math.min(total, 65536));
    const h = parsePlyHeader(headBytes);
    const allFloat = h.format === 'binary_little_endian' && h.properties.every(p => p.type === 'float32') && h.bodyOffset === h.headerBytes;
    if (!allFloat) return segments; // unexpected layout: leave as is
    const K = h.stride / 4;
    const ix = h.properties.find(p => p.name === 'x')!.offset / 4;
    const iy = h.properties.find(p => p.name === 'y')!.offset / 4;
    const iz = h.properties.find(p => p.name === 'z')!.offset / 4;
    // copy the body into whole-record blocks (records may straddle the writer's chunks)
    const store = new RecordStore(K);
    const carry = new Uint8Array(h.stride);
    const carryF = new Float32Array(carry.buffer);
    let carryLen = 0;
    let pos = 0; // absolute byte position at the start of the current segment
    for (const seg of segments) {
        let off = Math.max(0, h.headerBytes - pos);
        pos += seg.byteLength;
        if (off >= seg.byteLength) continue;
        if (carryLen > 0) {
            const n = Math.min(h.stride - carryLen, seg.byteLength - off);
            carry.set(seg.subarray(off, off + n), carryLen);
            carryLen += n;
            off += n;
            if (carryLen === h.stride) {
                const o = store.reserve();
                store.block.set(carryF, o);
                carryLen = 0;
            }
        }
        const whole = Math.floor((seg.byteLength - off) / h.stride);
        if (whole > 0) {
            let bytes = seg.subarray(off, off + whole * h.stride);
            if (bytes.byteOffset % 4 !== 0) bytes = bytes.slice();
            const f = new Float32Array(bytes.buffer, bytes.byteOffset, (whole * h.stride) / 4);
            for (let r = 0, b = 0; r < whole; r++, b += K) {
                const o = store.reserve();
                const dst = store.block;
                for (let k = 0; k < K; k++) dst[o + k] = f[b + k];
            }
            off += whole * h.stride;
        }
        if (off < seg.byteLength) {
            carry.set(seg.subarray(off), 0);
            carryLen = seg.byteLength - off;
        }
    }
    if (store.count !== h.vertexCount) throw new Error(`internal: re-read ${store.count} of ${h.vertexCount} records`);
    const sorted = mortonReorderStore(store, ix, iy, iz);
    store.release();
    return [concatPrefix(segments, h.headerBytes), ...sorted.segments()];
};

const concatPrefix = (segments: Uint8Array[], n: number): Uint8Array => {
    const out = new Uint8Array(n);
    let o = 0;
    for (const s of segments) {
        if (o >= n) break;
        const take = Math.min(n - o, s.byteLength);
        out.set(s.subarray(0, take), o);
        o += take;
    }
    return out;
};
