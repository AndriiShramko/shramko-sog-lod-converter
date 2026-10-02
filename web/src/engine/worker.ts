// The conversion worker: wires the browser (File, File System Access / OPFS, WebGPU, nested
// splat-transform workers) to the platform-neutral pipeline.

import { WebPCodec, WorkerQueue, type DeviceCreator } from '@playcanvas/splat-transform';
import stWorkerUrl from '@playcanvas/splat-transform/worker?url';
import webpWasmUrl from '@playcanvas/splat-transform/lib/webp.wasm?url';

import { runPipeline, type Stage } from './pipeline';
import type { FromWorker, StartMessage, ToWorker } from './protocol';
import type { InputBlob } from './tiling';
import { verifyArchive } from './verify';
import type { ByteSink } from './zip64';

WorkerQueue.workerUrl = stWorkerUrl;
WebPCodec.wasmUrl = webpWasmUrl;

const post = (m: FromWorker) => self.postMessage(m);

const signal = { aborted: false };
let currentStage: Stage = 'header';
let currentDetail = 'starting';
let running = false;

const fileBlob = (file: Blob): InputBlob => ({
    size: file.size,
    async read(start: number, end: number) {
        return new Uint8Array(await file.slice(start, end).arrayBuffer());
    }
});

/** Sink writing into a file the user picked (File System Access API). */
const fsaSink = async (handle: FileSystemFileHandle): Promise<ByteSink> => {
    const writable = await handle.createWritable({ keepExistingData: false });
    return {
        write: (data: Uint8Array) => writable.write(data as unknown as BufferSource),
        close: () => writable.close(),
        abort: (reason?: unknown) => writable.abort(reason).catch(() => undefined)
    };
};

/** Sink writing into the origin-private file system (browsers without a save dialog). */
const opfsSink = async (name: string): Promise<{ sink: ByteSink; file: () => Promise<File> }> => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(name, { create: true });
    const access = await (fh as unknown as { createSyncAccessHandle(): Promise<any> }).createSyncAccessHandle();
    access.truncate(0);
    let pos = 0;
    return {
        sink: {
            async write(data: Uint8Array) {
                let off = 0;
                while (off < data.byteLength) {
                    const n = access.write(data.subarray(off), { at: pos });
                    if (!(n > 0)) throw new Error('Could not write to browser storage (disk full or quota exceeded).');
                    off += n;
                    pos += n;
                }
            },
            async close() {
                access.flush();
                access.close();
            },
            async abort() {
                try {
                    access.close();
                } catch { /* already closed */ }
                await root.removeEntry(name).catch(() => undefined);
            }
        },
        file: () => fh.getFile()
    };
};

/** WebGPU device for splat-transform (decimation k-NN, SH k-means), created once. */
const makeDeviceCreator = (): DeviceCreator => {
    let devicePromise: ReturnType<DeviceCreator> | null = null;
    return () => {
        devicePromise ??= (async () => {
            if (!('gpu' in navigator) || !navigator.gpu) throw new Error('WebGPU is not available in this browser.');
            const { WebgpuGraphicsDevice } = await import('playcanvas');
            const canvas = new OffscreenCanvas(1024, 512);
            const device = new WebgpuGraphicsDevice(canvas as unknown as HTMLCanvasElement, { antialias: false, depth: false, stencil: false });
            await device.createDevice();
            // WebGPU reports OOM/validation errors asynchronously; a corrupted GPU result must never
            // be written out, so turn them into a hard failure (same policy as the splat-transform CLI).
            const wgpu = (device as unknown as { wgpu?: GPUDevice }).wgpu;
            wgpu?.addEventListener?.('uncapturederror', (ev: Event) => {
                const e = (ev as GPUUncapturedErrorEvent).error;
                const kind = e?.constructor?.name === 'GPUOutOfMemoryError' ? 'GPU out of memory' : 'GPU error';
                fail(new Error(`${kind}: ${e?.message || '(no message)'} — the result would be corrupted, so the conversion stopped.`));
            });
            wgpu?.lost?.then((info) => {
                if (info?.reason === 'destroyed') return;
                fail(new Error(`The GPU device was lost (${info?.reason || 'unknown'}: ${info?.message || 'no message'}). Close other GPU-heavy tabs or turn GPU off in Advanced settings.`));
            });
            return device;
        })();
        return devicePromise;
    };
};

let failed = false;
const fail = (err: unknown) => {
    if (failed) return;
    failed = true;
    signal.aborted = true;
    const e = err as Error & { code?: string };
    post({
        type: 'error',
        error: { name: e?.name ?? 'Error', message: e?.message ?? String(err), stack: e?.stack, code: e?.code },
        stage: currentStage,
        detail: currentDetail,
        cancelled: e?.name === 'AbortError'
    });
};

self.addEventListener('error', (e: ErrorEvent) => fail(e.error ?? new Error(e.message)));
self.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => fail(e.reason));

const start = async (msg: StartMessage) => {
    if (running) throw new Error('internal: a conversion is already running in this worker');
    running = true;
    const heartbeat = setInterval(() => post({ type: 'heartbeat' }), 2000);
    try {
        WorkerQueue.maxWorkers = msg.workers > 0 ? msg.workers : null;

        let createDevice: DeviceCreator | undefined;
        if (msg.useGpu) {
            const creator = makeDeviceCreator();
            try {
                const device = await creator();
                const info = (device as unknown as { gpuAdapter?: GPUAdapter }).gpuAdapter?.info;
                post({ type: 'gpu', ok: true, adapter: info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') : 'WebGPU' });
                createDevice = creator;
            } catch (err) {
                post({ type: 'gpu', ok: false, error: (err as Error)?.message ?? String(err) });
            }
        }

        let sink: ByteSink;
        let readBack: () => Promise<Blob>;
        let outputName: string;
        if (msg.output.kind === 'fsa') {
            const handle = msg.output.handle;
            sink = await fsaSink(handle);
            readBack = () => handle.getFile();
            outputName = handle.name;
        } else {
            const o = await opfsSink(msg.output.name);
            sink = o.sink;
            readBack = o.file;
            outputName = msg.output.name;
        }

        const result = await runPipeline({
            input: fileBlob(msg.file),
            output: sink,
            createDevice,
            signal,
            onEvent: ev => post({ type: 'event', ev }),
            onStage: (stage, detail) => {
                currentStage = stage;
                currentDetail = detail;
                post({ type: 'stage', stage, detail });
            }
        }, msg.settings);

        // verify what actually landed on disk
        currentStage = 'verify';
        currentDetail = 'reading the archive back';
        post({ type: 'stage', stage: 'verify', detail: currentDetail });
        const written = await readBack();
        const verify = await verifyArchive(fileBlob(written), result.counts, f => post({ type: 'verifying', fraction: f }));
        const { meta: _meta, ...rest } = result;
        post({ type: 'result', result: rest, verify, outputName });
    } catch (err) {
        fail(err);
    } finally {
        clearInterval(heartbeat);
        running = false;
    }
};

export const handleMessage = (e: MessageEvent<ToWorker>) => {
    const msg = e.data;
    if (msg.type === 'start') {
        start(msg);
    } else if (msg.type === 'cancel') {
        signal.aborted = true;
    }
};
