// In-memory storage used while a tile is being processed.
//
// Browsers cap a single ArrayBuffer at about 2 GiB, so nothing here ever allocates one big
// buffer: data lives in a list of blocks, and the read side stitches them together.

import { ReadStream, type FileSystem, type ReadSource, type Writer } from '@playcanvas/splat-transform';

/** A read-only byte source backed by a list of segments (e.g. a PLY header followed by body blocks). */
class SegmentReadSource implements ReadSource {
    readonly size: number;
    readonly seekable = true;
    private segments: Uint8Array[];
    private starts: number[];

    constructor(segments: Uint8Array[]) {
        this.segments = segments.filter(s => s.byteLength > 0);
        this.starts = [];
        let pos = 0;
        for (const s of this.segments) {
            this.starts.push(pos);
            pos += s.byteLength;
        }
        this.size = pos;
    }

    read(start = 0, end = this.size): ReadStream {
        const self = this;
        const from = Math.max(0, start);
        const to = Math.min(end, this.size);
        let pos = from;
        // binary search for the segment holding `pos`
        const findSeg = (p: number) => {
            let lo = 0, hi = self.starts.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (self.starts[mid] <= p) lo = mid; else hi = mid - 1;
            }
            return lo;
        };
        return new (class extends ReadStream {
            pull(target: Uint8Array): Promise<number> {
                let written = 0;
                while (written < target.byteLength && pos < to) {
                    const si = findSeg(pos);
                    const seg = self.segments[si];
                    const segOff = pos - self.starts[si];
                    const n = Math.min(target.byteLength - written, seg.byteLength - segOff, to - pos);
                    target.set(seg.subarray(segOff, segOff + n), written);
                    written += n;
                    pos += n;
                }
                this.bytesRead += written;
                return Promise.resolve(written);
            }
        })(to - from);
    }

    close(): void {
        // memory is released when the owner drops its references
    }
}

/**
 * Append-only store of fixed-size float32 records, split into blocks so no single buffer gets
 * near the browser's ~2 GiB ArrayBuffer limit.
 */
class RecordStore {
    readonly floatsPerRecord: number;
    readonly recordsPerBlock: number;
    private blocks: Float32Array[] = [];
    private fill = 0; // records in the last block
    count = 0;

    constructor(floatsPerRecord: number, blockBytes = 64 * 1024 * 1024) {
        this.floatsPerRecord = floatsPerRecord;
        this.recordsPerBlock = Math.max(1, Math.floor(blockBytes / (floatsPerRecord * 4)));
    }

    /** Current block; valid right after reserve(). */
    block: Float32Array = new Float32Array(0);

    /** Reserve the next record; returns its float offset inside `this.block`. */
    reserve(): number {
        if (this.blocks.length === 0 || this.fill === this.recordsPerBlock) {
            this.block = new Float32Array(this.recordsPerBlock * this.floatsPerRecord);
            this.blocks.push(this.block);
            this.fill = 0;
        }
        const offset = this.fill * this.floatsPerRecord;
        this.fill++;
        this.count++;
        return offset;
    }

    get bytes(): number {
        return this.count * this.floatsPerRecord * 4;
    }

    get allocatedBytes(): number {
        return this.blocks.length * this.recordsPerBlock * this.floatsPerRecord * 4;
    }

    /** Body segments (little-endian float32 records) in order. */
    segments(): Uint8Array[] {
        return this.blocks.map((b, i) => {
            const n = i === this.blocks.length - 1 ? this.fill : this.recordsPerBlock;
            return new Uint8Array(b.buffer, 0, n * this.floatsPerRecord * 4);
        });
    }

    release(): void {
        this.blocks = [];
        this.fill = 0;
        this.count = 0;
    }
}

/** A writable in-memory file system (used for decimated levels and for capturing small files). */
class MemoryFs implements FileSystem {
    files = new Map<string, Uint8Array[]>();

    createWriter(filename: string): Writer {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const files = this.files;
        return {
            get bytesWritten() {
                return bytes;
            },
            write(data: Uint8Array) {
                // the caller may reuse its buffer after write() returns, so keep a copy
                chunks.push(data.slice());
                bytes += data.byteLength;
            },
            close() {
                files.set(filename, chunks);
            },
            abort() {
                chunks.length = 0;
            }
        };
    }

    mkdir(): Promise<void> {
        return Promise.resolve();
    }

    source(filename: string): SegmentReadSource {
        const chunks = this.files.get(filename);
        if (!chunks) throw new Error(`internal: ${filename} was not written`);
        return new SegmentReadSource(chunks);
    }

    remove(filename: string): void {
        this.files.delete(filename);
    }

    get totalBytes(): number {
        let n = 0;
        for (const chunks of this.files.values()) for (const c of chunks) n += c.byteLength;
        return n;
    }
}

export { SegmentReadSource, RecordStore, MemoryFs };
