// Run the browser pipeline under Node, for fast tests without a browser.
//
//   npx tsx tools/node-convert.ts <input.ply> <output.zip> [--memory-gb 8] [--tile-splats N] [--levels-min 1000000]
//
// Uses the same engine code as the web worker (CPU only: no WebGPU in this harness), then
// re-reads the written archive with the same verifier the web app runs.

import { open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { DEFAULT_SETTINGS, runPipeline, type ConvertSettings } from '../web/src/engine/pipeline';
import { verifyArchive } from '../web/src/engine/verify';
import type { InputBlob } from '../web/src/engine/tiling';
import type { ByteSink } from '../web/src/engine/zip64';

const args = process.argv.slice(2);
const flag = (name: string, def?: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
};
const [inPath, outPath] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!inPath || !outPath) {
    console.error('usage: tsx tools/node-convert.ts <input.ply> <output.zip> [--memory-gb N] [--tile-splats N] [--min-coarsest N] [--max-levels N]');
    process.exit(2);
}

const fileInput = async (path: string): Promise<InputBlob & { close(): Promise<void> }> => {
    const fh = await open(path, 'r');
    const { size } = await fh.stat();
    return {
        size,
        async read(start: number, end: number) {
            const len = Math.max(0, Math.min(end, size) - start);
            const buf = new Uint8Array(new ArrayBuffer(len));
            let got = 0;
            while (got < len) {
                const { bytesRead } = await fh.read(buf, got, len - got, start + got);
                if (bytesRead === 0) break;
                got += bytesRead;
            }
            return got === len ? buf : buf.subarray(0, got);
        },
        close: () => fh.close()
    };
};

const fileSink = async (path: string): Promise<ByteSink> => {
    const fh = await open(path, 'w');
    return {
        async write(data: Uint8Array) {
            let off = 0;
            while (off < data.byteLength) {
                const { bytesWritten } = await fh.write(data, off, data.byteLength - off);
                off += bytesWritten;
            }
        },
        close: () => fh.close(),
        abort: () => fh.close()
    };
};

const main = async () => {
    const settings: ConvertSettings = {
        ...DEFAULT_SETTINGS,
        memoryBytes: parseFloat(flag('--memory-gb', '8')!) * 1024 ** 3,
        tileSplats: parseInt(flag('--tile-splats', '0')!, 10),
        minCoarsest: parseInt(flag('--min-coarsest', `${DEFAULT_SETTINGS.minCoarsest}`)!, 10),
        maxLevels: parseInt(flag('--max-levels', '0')!, 10),
        rotation: (flag('--rotate', '0,0,0')!.split(',').map(Number) as [number, number, number]),
        decimator: flag('--decimator', 'uniform') === 'adaptive' ? 'adaptive' : 'uniform'
    };
    const input = await fileInput(inPath);
    const output = await fileSink(outPath);
    let lastLine = '';
    const t0 = performance.now();
    const result = await runPipeline({
        input,
        output,
        signal: { aborted: false },
        onEvent: (ev) => {
            if (ev.type === 'plan') console.log('PLAN', JSON.stringify(ev.plan));
            else if (ev.type === 'log') console.log(`[${ev.level}] ${ev.text}`);
            else if (ev.type === 'progress') {
                const line = `${(ev.overall * 100).toFixed(1)}% ${ev.label}`;
                if (line !== lastLine && Math.random() < 0.05) console.log(line, ev.etaSeconds ? `eta ${ev.etaSeconds.toFixed(0)}s` : '');
                lastLine = line;
            }
        }
    }, settings);
    await input.close();
    console.log('RESULT', JSON.stringify({ counts: result.counts, archiveBytes: result.archiveBytes, entries: result.entries, tiles: result.tiles, seconds: result.seconds.toFixed(1), timings: result.timings }));

    const zip = await fileInput(outPath);
    const report = await verifyArchive(zip, result.counts);
    await zip.close();
    console.log('VERIFY', JSON.stringify(report));
    console.log(`total ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    process.exit(report.ok ? 0 : 1);
};

main().catch((err) => {
    console.error('FAILED', err?.stack ?? err);
    process.exit(1);
});
