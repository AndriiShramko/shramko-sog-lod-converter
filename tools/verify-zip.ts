// Verify any Streamed SOG (.zip) the way the web app does: names superspl.at accepts,
// lod-meta.json at the root, real LOD levels, counts consistent with the tree, every unit file present.
//
//   npx tsx tools/verify-zip.ts <archive.zip> [expectedCountsJson]
// Exit code 0 = ok, 1 = problems found.

import { open } from 'node:fs/promises';

import { verifyArchive } from '../web/src/engine/verify';

const [path, expected] = process.argv.slice(2);
if (!path) {
    console.error('usage: verify-zip.ts <archive.zip> [expectedCountsJson]');
    process.exit(2);
}

const main = async () => {
    const fh = await open(path, 'r');
    const { size } = await fh.stat();
    const report = await verifyArchive({
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
        }
    }, expected ? JSON.parse(expected) : undefined);
    await fh.close();
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
};

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
