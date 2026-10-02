// ZIP64 writer test: builds archives that cross the 4 GiB offset and the 65,535-entry limits,
// then reads them back with our own reader. The Python check (tools/test-zip64.py) reads the
// same files with an independent implementation.
//
//   npx tsx tools/test-zip64.ts <dir>

import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { readZipDirectory, readZipEntry } from '../web/src/engine/verify';
import { ZipWriter, crc32, type ByteSink } from '../web/src/engine/zip64';
import type { InputBlob } from '../web/src/engine/tiling';

const dir = process.argv[2];
if (!dir) throw new Error('usage: test-zip64.ts <dir>');

const sink = async (path: string): Promise<ByteSink> => {
    const fh = await open(path, 'w');
    return {
        async write(d: Uint8Array) {
            let o = 0;
            while (o < d.byteLength) o += (await fh.write(d, o, d.byteLength - o)).bytesWritten;
        },
        close: () => fh.close(),
        abort: () => fh.close()
    };
};

const blob = async (path: string): Promise<InputBlob & { close(): Promise<void> }> => {
    const fh = await open(path, 'r');
    const { size } = await fh.stat();
    return {
        size,
        async read(s: number, e: number) {
            const b = new Uint8Array(e - s);
            let got = 0;
            while (got < b.length) {
                const { bytesRead } = await fh.read(b, got, b.length - got, s + got);
                if (!bytesRead) break;
                got += bytesRead;
            }
            return b;
        },
        close: () => fh.close()
    };
};

const check = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`FAIL: ${msg}`);
    console.log(`ok   ${msg}`);
};

const main = async () => {
    // CRC sanity against a known vector
    check(crc32(new TextEncoder().encode('123456789')) === 0xCBF43926, 'crc32("123456789") = CBF43926');

    // 1) many entries → ZIP64 end records
    const many = join(dir, 'zip64-many.zip');
    {
        const z = new ZipWriter(await sink(many));
        for (let i = 0; i < 70_000; i++) await z.add(`d${i % 7}/f${i}.txt`, new TextEncoder().encode(`entry ${i}`));
        await z.finish();
        const b = await blob(many);
        const { entries, zip64 } = await readZipDirectory(b);
        check(zip64, 'archive with 70,000 entries uses ZIP64 end records');
        check(entries.length === 70_000, `reads back 70,000 entries (got ${entries.length})`);
        const last = await readZipEntry(b, entries[69_999]);
        check(new TextDecoder().decode(last) === 'entry 69999', 'last entry content intact');
        await b.close();
    }

    // 2) entries beyond 4 GiB → ZIP64 offsets in the central directory
    const big = join(dir, 'zip64-big.zip');
    {
        const z = new ZipWriter(await sink(big));
        const chunk = new Uint8Array(1024 * 1024 * 1024 - 7); // just under 1 GiB each
        for (let i = 0; i < chunk.length; i += 4096) chunk[i] = i & 0xff;
        for (let i = 0; i < 5; i++) await z.add(`big/part${i}.bin`, chunk);
        await z.add('after/meta.json', new TextEncoder().encode('{"after":4GiB}'));
        await z.add('lod-meta.json', new TextEncoder().encode('{"ok":true}'));
        await z.finish();
        const b = await blob(big);
        check(b.size > 5 * 1024 ** 3, `archive is over 5 GiB (${b.size} bytes)`);
        const { entries, zip64 } = await readZipDirectory(b);
        check(zip64, 'archive over 4 GiB uses ZIP64');
        const after = entries.find(e => e.name === 'after/meta.json')!;
        check(after.offset > 0xFFFFFFFF, `entry after 4 GiB has a 64-bit offset (${after.offset})`);
        check(new TextDecoder().decode(await readZipEntry(b, after)) === '{"after":4GiB}', 'entry after 4 GiB reads back intact');
        const lm = entries.find(e => e.name === 'lod-meta.json')!;
        check(new TextDecoder().decode(await readZipEntry(b, lm)) === '{"ok":true}', 'lod-meta.json at root reads back');
        await b.close();
    }
    console.log('ALL OK — now run: python tools/test-zip64.py', dir);
};

main().catch(async (e) => {
    console.error(e);
    await rm(join(dir, 'zip64-big.zip'), { force: true });
    process.exit(1);
});
