// Streaming ZIP writer with ZIP64 support.
//
// splat-transform's own ZipFileSystem stops at 4 GiB, and a Streamed SOG of a few hundred
// million splats is bigger than that. Every entry here is small (a WebP texture or a JSON
// file), so each one is buffered whole, its CRC computed, and then written with a complete
// local header (no data descriptors). Entries are stored (no compression): WebP is already
// compressed. The archive is written strictly sequentially, so it can stream straight to disk.

/** Where the archive bytes go. */
export interface ByteSink {
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256 * 8);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    // slicing-by-8 tables
    for (let n = 0; n < 256; n++) {
        let c = t[n];
        for (let k = 1; k < 8; k++) {
            c = t[c & 0xff] ^ (c >>> 8);
            t[k * 256 + n] = c >>> 0;
        }
    }
    return t;
})();

/** CRC-32 (IEEE) of `data`. */
export const crc32 = (data: Uint8Array, crc = 0): number => {
    let c = ~crc >>> 0;
    const t = CRC_TABLE;
    let i = 0;
    const n = data.length;
    // slicing-by-8 main loop
    for (; i + 8 <= n; i += 8) {
        c ^= data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
        const hi = data[i + 4] | (data[i + 5] << 8) | (data[i + 6] << 16) | (data[i + 7] << 24);
        c = t[7 * 256 + (c & 0xff)] ^ t[6 * 256 + ((c >>> 8) & 0xff)] ^
            t[5 * 256 + ((c >>> 16) & 0xff)] ^ t[4 * 256 + (c >>> 24)] ^
            t[3 * 256 + (hi & 0xff)] ^ t[2 * 256 + ((hi >>> 8) & 0xff)] ^
            t[256 + ((hi >>> 16) & 0xff)] ^ t[hi >>> 24];
    }
    for (; i < n; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
};

type CentralEntry = { name: Uint8Array; crc: number; size: number; offset: number };

const U32_MAX = 0xFFFFFFFF;

/** Buffers small writes into large ones (each write to a browser file stream has a fixed cost). */
class BufferedSink implements ByteSink {
    private sink: ByteSink;
    private buf: Uint8Array;
    private len = 0;

    constructor(sink: ByteSink, bufferBytes = 32 * 1024 * 1024) {
        this.sink = sink;
        this.buf = new Uint8Array(bufferBytes);
    }

    async write(data: Uint8Array): Promise<void> {
        if (data.byteLength >= this.buf.byteLength) {
            await this.flush();
            await this.sink.write(data);
            return;
        }
        if (this.len + data.byteLength > this.buf.byteLength) await this.flush();
        this.buf.set(data, this.len);
        this.len += data.byteLength;
    }

    async flush(): Promise<void> {
        if (this.len > 0) {
            // hand over a copy-free view, then start a fresh buffer (the sink may hold on to it)
            const out = this.buf.subarray(0, this.len);
            this.buf = new Uint8Array(this.buf.byteLength);
            this.len = 0;
            await this.sink.write(out);
        }
    }

    async close(): Promise<void> {
        await this.flush();
        await this.sink.close();
    }

    abort(reason?: unknown): Promise<void> {
        this.len = 0;
        return this.sink.abort(reason);
    }
}

export class ZipWriter {
    private sink: BufferedSink;
    private entries: CentralEntry[] = [];
    private names = new Set<string>();
    private offset = 0;
    private dosTime: number;
    private dosDate: number;
    private finished = false;

    constructor(sink: ByteSink, date = new Date()) {
        this.sink = new BufferedSink(sink);
        this.dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
        this.dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    }

    /** Bytes written to the archive so far. */
    get bytesWritten(): number {
        return this.offset;
    }

    get entryCount(): number {
        return this.entries.length;
    }

    get entryNames(): string[] {
        const dec = new TextDecoder();
        return this.entries.map(e => dec.decode(e.name));
    }

    /** Add one stored entry. `name` uses forward slashes, no leading slash. */
    async add(name: string, data: Uint8Array): Promise<void> {
        if (this.finished) throw new Error('internal: zip already finished');
        if (name.startsWith('/') || name.includes('\\') || name.includes('..')) throw new Error(`internal: bad zip entry name ${name}`);
        if (this.names.has(name)) throw new Error(`internal: duplicate zip entry ${name}`);
        if (data.byteLength >= U32_MAX) throw new Error(`internal: zip entry ${name} is too large`);
        this.names.add(name);

        const nameBytes = new TextEncoder().encode(name);
        const crc = crc32(data);
        const header = new Uint8Array(30 + nameBytes.length);
        const v = new DataView(header.buffer);
        v.setUint32(0, 0x04034b50, true);   // local file header signature
        v.setUint16(4, 20, true);            // version needed to extract
        v.setUint16(6, 0x0800, true);        // general purpose flags: UTF-8 names
        v.setUint16(8, 0, true);             // method: store
        v.setUint16(10, this.dosTime, true);
        v.setUint16(12, this.dosDate, true);
        v.setUint32(14, crc, true);
        v.setUint32(18, data.byteLength, true); // compressed size
        v.setUint32(22, data.byteLength, true); // uncompressed size
        v.setUint16(26, nameBytes.length, true);
        v.setUint16(28, 0, true);            // extra field length
        header.set(nameBytes, 30);

        this.entries.push({ name: nameBytes, crc, size: data.byteLength, offset: this.offset });
        await this.sink.write(header);
        await this.sink.write(data);
        this.offset += header.byteLength + data.byteLength;
    }

    /** Write the central directory (ZIP64 when needed) and close the sink. */
    async finish(): Promise<void> {
        if (this.finished) return;
        this.finished = true;
        const cdStart = this.offset;
        let cdSize = 0;

        for (const e of this.entries) {
            const needZip64 = e.offset >= U32_MAX;
            const extraLen = needZip64 ? 12 : 0;
            const rec = new Uint8Array(46 + e.name.length + extraLen);
            const v = new DataView(rec.buffer);
            v.setUint32(0, 0x02014b50, true);       // central file header signature
            v.setUint16(4, 45, true);                // version made by (4.5, MS-DOS)
            v.setUint16(6, needZip64 ? 45 : 20, true); // version needed
            v.setUint16(8, 0x0800, true);
            v.setUint16(10, 0, true);
            v.setUint16(12, this.dosTime, true);
            v.setUint16(14, this.dosDate, true);
            v.setUint32(16, e.crc, true);
            v.setUint32(20, e.size, true);
            v.setUint32(24, e.size, true);
            v.setUint16(28, e.name.length, true);
            v.setUint16(30, extraLen, true);
            v.setUint16(32, 0, true);                // comment length
            v.setUint16(34, 0, true);                // disk number start
            v.setUint16(36, 0, true);                // internal attributes
            v.setUint32(38, 0, true);                // external attributes
            v.setUint32(42, needZip64 ? U32_MAX : e.offset, true);
            rec.set(e.name, 46);
            if (needZip64) {
                const x = 46 + e.name.length;
                v.setUint16(x, 0x0001, true);        // ZIP64 extended information
                v.setUint16(x + 2, 8, true);
                v.setBigUint64(x + 4, BigInt(e.offset), true);
            }
            await this.sink.write(rec);
            cdSize += rec.byteLength;
        }
        this.offset += cdSize;

        const count = this.entries.length;
        const needZip64 = count >= 0xFFFF || cdStart >= U32_MAX || cdSize >= U32_MAX;
        if (needZip64) {
            const zip64EocdOffset = this.offset;
            const rec = new Uint8Array(56 + 20);
            const v = new DataView(rec.buffer);
            v.setUint32(0, 0x06064b50, true);        // ZIP64 end of central directory record
            v.setBigUint64(4, BigInt(44), true);     // size of the remaining record
            v.setUint16(12, 45, true);
            v.setUint16(14, 45, true);
            v.setUint32(16, 0, true);
            v.setUint32(20, 0, true);
            v.setBigUint64(24, BigInt(count), true);
            v.setBigUint64(32, BigInt(count), true);
            v.setBigUint64(40, BigInt(cdSize), true);
            v.setBigUint64(48, BigInt(cdStart), true);
            v.setUint32(56, 0x07064b50, true);       // ZIP64 end of central directory locator
            v.setUint32(60, 0, true);
            v.setBigUint64(64, BigInt(zip64EocdOffset), true);
            v.setUint32(72, 1, true);
            await this.sink.write(rec);
            this.offset += rec.byteLength;
        }

        const eocd = new Uint8Array(22);
        const v = new DataView(eocd.buffer);
        v.setUint32(0, 0x06054b50, true);
        v.setUint16(4, 0, true);
        v.setUint16(6, 0, true);
        v.setUint16(8, Math.min(count, 0xFFFF), true);
        v.setUint16(10, Math.min(count, 0xFFFF), true);
        v.setUint32(12, Math.min(cdSize, U32_MAX), true);
        v.setUint32(16, cdStart >= U32_MAX ? U32_MAX : cdStart, true);
        v.setUint16(20, 0, true);
        await this.sink.write(eocd);
        this.offset += eocd.byteLength;

        await this.sink.close();
    }

    abort(reason?: unknown): Promise<void> {
        this.finished = true;
        return this.sink.abort(reason);
    }
}
