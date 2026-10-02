// Independent check of a finished archive, read back from disk.
//
// "Converted" is not the same as "the file is right": this reads the zip that was actually
// written (its central directory, lod-meta.json and every unit meta.json) and checks it the way
// superspl.at's upload form and the PlayCanvas streaming loader will see it.

import { UNIT_FILES, type LodMeta, type LodNode } from './lod-merge';
import type { InputBlob } from './tiling';

export interface ZipEntryInfo {
    name: string;
    size: number;
    offset: number; // local header offset
}

export interface VerifyReport {
    ok: boolean;
    errors: string[];
    warnings: string[];
    archiveBytes: number;
    entries: number;
    units: number;
    lodLevels: number;
    counts: number[];
    zip64: boolean;
}

const SUPERSPLAT_LIMIT = 10 * 1024 ** 3;

const u64 = (v: DataView, o: number) => Number(v.getBigUint64(o, true));

/** Read the central directory of a (possibly ZIP64) archive. */
export const readZipDirectory = async (zip: InputBlob): Promise<{ entries: ZipEntryInfo[]; zip64: boolean }> => {
    const tailLen = Math.min(zip.size, 65557);
    const tail = await zip.read(zip.size - tailLen, zip.size);
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
        if (tv.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record).');
    let count = tv.getUint16(eocd + 10, true);
    let cdSize = tv.getUint32(eocd + 12, true);
    let cdOffset = tv.getUint32(eocd + 16, true);
    let zip64 = false;
    if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
        zip64 = true;
        const locAt = zip.size - tailLen + eocd - 20;
        const loc = await zip.read(locAt, locAt + 20);
        const lv = new DataView(loc.buffer, loc.byteOffset, 20);
        if (lv.getUint32(0, true) !== 0x07064b50) throw new Error('ZIP64 locator missing.');
        const recAt = u64(lv, 8);
        const rec = await zip.read(recAt, recAt + 56);
        const rv = new DataView(rec.buffer, rec.byteOffset, 56);
        if (rv.getUint32(0, true) !== 0x06064b50) throw new Error('ZIP64 end-of-central-directory record missing.');
        count = u64(rv, 32);
        cdSize = u64(rv, 40);
        cdOffset = u64(rv, 48);
    }
    const cd = await zip.read(cdOffset, cdOffset + cdSize);
    const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const dec = new TextDecoder();
    const entries: ZipEntryInfo[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
        if (v.getUint32(p, true) !== 0x02014b50) throw new Error(`Central directory is corrupt at entry ${i}.`);
        let size = v.getUint32(p + 24, true);
        let offset = v.getUint32(p + 42, true);
        const nameLen = v.getUint16(p + 28, true);
        const extraLen = v.getUint16(p + 30, true);
        const commentLen = v.getUint16(p + 32, true);
        const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));
        // ZIP64 extra field: values appear in order only for fields set to 0xFFFFFFFF
        let x = p + 46 + nameLen;
        const xEnd = x + extraLen;
        while (x + 4 <= xEnd) {
            const id = v.getUint16(x, true);
            const len = v.getUint16(x + 2, true);
            if (id === 0x0001) {
                let q = x + 4;
                if (v.getUint32(p + 24, true) === 0xFFFFFFFF) { size = u64(v, q); q += 8; }
                if (v.getUint32(p + 20, true) === 0xFFFFFFFF) { q += 8; }
                if (v.getUint32(p + 42, true) === 0xFFFFFFFF) { offset = u64(v, q); q += 8; }
            }
            x += 4 + len;
        }
        entries.push({ name, size, offset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, zip64 };
};

/** Read one stored entry's bytes. */
export const readZipEntry = async (zip: InputBlob, e: ZipEntryInfo): Promise<Uint8Array> => {
    const h = await zip.read(e.offset, e.offset + 30);
    const hv = new DataView(h.buffer, h.byteOffset, 30);
    if (hv.getUint32(0, true) !== 0x04034b50) throw new Error(`Local header of ${e.name} is corrupt.`);
    if (hv.getUint16(8, true) !== 0) throw new Error(`${e.name} is compressed; expected stored.`);
    const start = e.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    return zip.read(start, start + e.size);
};

/**
 * Verify a Streamed SOG archive.
 * @param expectedCounts - Per-level splat counts the converter intended to write (optional).
 */
export const verifyArchive = async (
    zip: InputBlob,
    expectedCounts?: number[],
    onProgress?: (fraction: number) => void
): Promise<VerifyReport> => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const { entries, zip64 } = await readZipDirectory(zip);
    const byName = new Map(entries.map(e => [e.name, e]));

    // names the superspl.at upload form accepts
    for (const e of entries) {
        if (e.name === 'lod-meta.json') continue;
        const parts = e.name.split('/');
        if (parts.length !== 2 || !parts[0] || !UNIT_FILES.has(parts[1])) {
            errors.push(`Unexpected file in archive: ${e.name} (superspl.at rejects archives with extra files).`);
        }
    }

    const metaEntry = byName.get('lod-meta.json');
    const report: VerifyReport = {
        ok: false, errors, warnings, archiveBytes: zip.size, entries: entries.length,
        units: 0, lodLevels: 0, counts: [], zip64
    };
    if (!metaEntry) {
        errors.push('lod-meta.json is not at the root of the archive.');
        return report;
    }

    const meta = JSON.parse(new TextDecoder().decode(await readZipEntry(zip, metaEntry))) as LodMeta;
    report.lodLevels = meta.lodLevels;
    report.counts = meta.counts ?? [];
    report.units = meta.filenames?.length ?? 0;

    if (meta.version !== 1) errors.push(`lod-meta.json version is ${meta.version}, expected 1.`);
    if (!Array.isArray(meta.counts) || meta.counts.length !== meta.lodLevels) {
        errors.push('lod-meta.json "counts" does not match "lodLevels".');
    }
    const total = (meta.counts ?? []).reduce((a, b) => a + b, 0);
    if (meta.count !== total) errors.push(`lod-meta.json "count" (${meta.count}) is not the sum of "counts" (${total}).`);
    if (meta.lodLevels < 2) {
        if ((meta.counts?.[0] ?? 0) >= 1_000_000) {
            errors.push(`Only ${meta.lodLevels} level of detail: the archive has no LODs (the scene is just cut into chunks).`);
        } else {
            warnings.push('Only one level of detail (fine for scenes under 1M splats).');
        }
    }
    for (let i = 1; i < (meta.counts?.length ?? 0); i++) {
        if (!(meta.counts[i] < meta.counts[i - 1])) errors.push(`Level ${i} (${meta.counts[i]}) is not smaller than level ${i - 1} (${meta.counts[i - 1]}).`);
    }
    if (expectedCounts) {
        const same = expectedCounts.length === meta.counts.length && expectedCounts.every((c, i) => c === meta.counts[i]);
        if (!same) errors.push(`Per-level counts ${JSON.stringify(meta.counts)} differ from what was converted ${JSON.stringify(expectedCounts)}.`);
    }

    // every referenced unit exists; leaf ranges per unit
    const ranges = new Map<number, { offset: number; count: number }[]>();
    const levelSums = new Array(meta.lodLevels).fill(0);
    const walk = (node: LodNode) => {
        if (node.children) {
            node.children.forEach(walk);
            return;
        }
        for (const [k, ref] of Object.entries(node.lods ?? {})) {
            const lod = parseInt(k, 10);
            if (lod >= 0 && lod < meta.lodLevels) levelSums[lod] += ref.count;
            if (!ranges.has(ref.file)) ranges.set(ref.file, []);
            ranges.get(ref.file)!.push({ offset: ref.offset, count: ref.count });
        }
    };
    walk(meta.tree);
    levelSums.forEach((s, i) => {
        if (s !== meta.counts[i]) errors.push(`Tree holds ${s} splats on level ${i}, but counts says ${meta.counts[i]}.`);
    });

    const files = meta.filenames ?? [];
    for (let i = 0; i < files.length; i++) {
        const entry = byName.get(files[i]);
        if (!entry) {
            errors.push(`Missing unit ${files[i]}.`);
            continue;
        }
        const unit = JSON.parse(new TextDecoder().decode(await readZipEntry(zip, entry)));
        const dir = files[i].substring(0, files[i].lastIndexOf('/'));
        const referenced: string[] = [];
        for (const v of Object.values(unit) as any[]) {
            if (v && Array.isArray(v.files)) referenced.push(...v.files);
        }
        for (const f of referenced) {
            if (!byName.has(`${dir}/${f}`)) errors.push(`Unit ${dir} lists ${f}, which is missing.`);
        }
        const rs = (ranges.get(i) ?? []).sort((a, b) => a.offset - b.offset);
        let pos = 0;
        for (const r of rs) {
            if (r.offset !== pos) {
                errors.push(`Unit ${dir}: leaf ranges are not contiguous at row ${pos}.`);
                break;
            }
            pos += r.count;
        }
        if (pos !== unit.count) errors.push(`Unit ${dir} holds ${unit.count} splats but the tree references ${pos}.`);
        if (i % 50 === 0) onProgress?.(i / files.length);
    }
    onProgress?.(1);

    if (zip.size > SUPERSPLAT_LIMIT) {
        warnings.push(`The archive is ${(zip.size / 1024 ** 3).toFixed(2)} GiB — over superspl.at's 10 GiB upload limit.`);
    }
    report.ok = errors.length === 0;
    return report;
};
