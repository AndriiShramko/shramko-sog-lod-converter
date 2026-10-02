// The conversion pipeline: giant PLY → multi-LOD Streamed SOG (.zip) for SuperSplat.
//
//   1. read the PLY header, plan the LOD levels (SuperSplat's own policy: halve each level
//      until it holds ≤ 1M splats) and the memory budget
//   2. sample positions and plan a k-d tiling so every tile fits in memory
//   3. for each group of tiles: one sequential pass over the file copies those tiles' splats
//      into memory; then each tile is converted on its own with splat-transform —
//      decimation for every level, then the LOD writer (SOG compression, WebP)
//   4. tiles' files stream into one ZIP64 archive; the tile trees are joined into one
//      lod-meta.json, written last
//
// Platform-neutral: the browser worker and the Node test harness both drive it.

import { Vec3 } from 'playcanvas';
import {
    bakeTransform,
    createChunkDataPool,
    decimateSource,
    decimateSourceAdaptive,
    logger,
    processSource,
    readPly,
    stackLods,
    Transform,
    version as stVersion,
    writeLodSource,
    writeSource,
    type ChunkSource,
    type DeviceCreator,
    type LogEvent
} from '@playcanvas/splat-transform';

import { LodMerger, serializeMeta, type LodMeta } from './lod-merge';
import { MemoryFs, SegmentReadSource } from './memory';
import { mortonReorderPly, mortonReorderStore } from './morton';
import { buildPlyHeader, keptPropertyNames, modelComments, parsePlyHeader, type PlyHeader } from './ply-header';
import { CONVERTER_VERSION, INITIAL, decimatorFactor, groupBytes, outBytesPerSplat, planLevels, tileSize, type ConvertSettings, type PlanInfo, type Stage } from './plan';
import { routeGroup } from './router';
import { groupTiles, planTiles, samplePositions, type InputBlob, type KdPlan } from './tiling';
import { ZipWriter, type ByteSink } from './zip64';

export type PipelineEvent =
    | { type: 'plan'; plan: PlanInfo }
    | { type: 'progress'; stage: Stage; overall: number; stageFraction: number; label: string; tile?: number; tiles?: number; level?: number; etaSeconds?: number; bytesWritten?: number; memoryBytes?: number }
    | { type: 'log'; level: 'info' | 'warn' | 'error' | 'debug'; text: string }
    | { type: 'tileDone'; tile: number; tiles: number; counts: number[]; seconds: number };

export interface PipelineEnv {
    input: InputBlob;
    output: ByteSink;
    createDevice?: DeviceCreator;
    onEvent: (ev: PipelineEvent) => void;
    signal: { aborted: boolean };
    /** Called with the current stage on every step, so a crash report can say where it happened. */
    onStage?: (stage: Stage, detail: string) => void;
}

export interface PipelineResult {
    meta: LodMeta;
    counts: number[];
    archiveBytes: number;
    entries: number;
    seconds: number;
    tiles: number;
    timings: { sample: number; read: number; decimate: number; encode: number; finalize: number };
}

export const runPipeline = async (env: PipelineEnv, settings: ConvertSettings): Promise<PipelineResult> => {
    const t0 = performance.now();
    const s = settings;
    const emit = env.onEvent;
    const stage = (st: Stage, detail: string) => env.onStage?.(st, detail);
    const checkAbort = () => {
        if (env.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    };

    // --- 1. header
    stage('header', 'reading PLY header');
    const head = await env.input.read(0, Math.min(env.input.size, 256 * 1024));
    const header: PlyHeader = parsePlyHeader(head);
    const expectedSize = header.bodyOffset + header.vertexCount * header.stride;
    if (env.input.size < expectedSize) {
        throw new Error(`The file is ${env.input.size} bytes but its header needs ${expectedSize}: it is truncated (incomplete copy or download?).`);
    }
    const kept = keptPropertyNames(header);
    const keptFloats = kept.length;
    const keptSh = s.shBands < 0 ? header.shBands : Math.min(header.shBands, s.shBands);
    const levelsPlan = planLevels(header.vertexCount, s);

    const tileSplats = tileSize(keptFloats, s);
    const groupBudget = groupBytes(keptFloats, tileSplats, s);

    // --- 2. sample + tiling
    stage('sample', 'sampling positions');
    emit({ type: 'progress', stage: 'sample', overall: 0, stageFraction: 0, label: 'Sampling splat positions' });
    const sampleBlocks = 2048;
    const sample = await samplePositions(env.input, header, {
        blocks: sampleBlocks,
        blockRecords: Math.max(64, Math.floor(2_000_000 / sampleBlocks)),
        signal: env.signal,
        onProgress: f => emit({ type: 'progress', stage: 'sample', overall: 0.005 * f, stageFraction: f, label: 'Sampling splat positions' })
    });
    if (sample.count === 0) throw new Error('No splat in the sample has a valid position (all NaN/Inf). The file looks corrupted.');
    const plan: KdPlan = planTiles(sample.xyz, sample.count, header.vertexCount, tileSplats);
    const groups = groupTiles(plan.estimates, keptFloats * 4, groupBudget);
    const tSample = performance.now();

    // cost model
    const bodyBytes = header.vertexCount * header.stride;
    let readBps = INITIAL.readBps;
    // CPU-only decimation is ~4× slower (measured: 29 vs 7.5 µs/splat)
    let decPer = INITIAL.decimatePerSplat * (env.createDevice ? 1 : 4) * decimatorFactor(s);
    let encPer = INITIAL.encodePerSplat;
    const decInputTotal = levelsPlan.slice(0, -1).reduce((a, b) => a + b, 0);
    const encTotal = levelsPlan.reduce((a, b) => a + b, 0);
    const estimate = () => groups.length * bodyBytes / readBps + decInputTotal * decPer + encTotal * encPer;
    const bytesPerSplatOut = outBytesPerSplat(keptSh);

    const planInfo: PlanInfo = {
        splats: header.vertexCount,
        fileBytes: env.input.size,
        shBands: header.shBands,
        keptShBands: keptSh,
        properties: kept,
        droppedProperties: header.extraProperties,
        levels: levelsPlan,
        tiles: plan.tileCount,
        passes: groups.length,
        tileSplats,
        estimatedSeconds: estimate(),
        estimatedOutputBytes: Math.round(encTotal * bytesPerSplatOut)
    };
    emit({ type: 'plan', plan: planInfo });
    emit({ type: 'log', level: 'info', text: `${header.vertexCount.toLocaleString('en-US')} splats, SH bands ${header.shBands}${keptSh !== header.shBands ? ` → ${keptSh}` : ''}; ${levelsPlan.length} LOD levels; ${plan.tileCount} tiles in ${groups.length} pass(es)` });
    if (header.extraProperties.length > 0) {
        emit({ type: 'log', level: 'info', text: `Not part of a splat, dropped: ${header.extraProperties.join(', ')}` });
    }
    if (levelsPlan.length === 1) {
        emit({ type: 'log', level: 'warn', text: `The scene has ${header.vertexCount.toLocaleString('en-US')} splats (≤ ${s.minCoarsest.toLocaleString('en-US')}), so one level is enough — no coarser LODs are made.` });
    }

    // --- progress bookkeeping
    let workDone = 0; // estimated seconds of work completed (in current model units)
    const totalWork = () => estimate();
    let lastEmit = 0;
    let currentStageFraction = 0;
    let currentLabel = '';
    let currentStage: Stage = 'read';
    let currentTile = 0;
    let currentLevel: number | undefined;
    let stepWork = 0; // estimated seconds of the running step
    const startWall = performance.now();
    const zipRef: { zip?: ZipWriter } = {};
    const report = (force = false) => {
        const now = performance.now();
        if (!force && now - lastEmit < 250) return;
        lastEmit = now;
        const total = totalWork();
        const done = Math.min(total, workDone + stepWork * currentStageFraction);
        const overall = Math.min(0.995, 0.005 + 0.99 * (done / total));
        const elapsed = (now - startWall) / 1000;
        // blend model ETA with observed rate once some work is done
        const modelEta = Math.max(0, total - done);
        const observedEta = overall > 0.03 ? elapsed * (1 - overall) / overall : modelEta;
        const etaSeconds = overall > 0.03 ? 0.5 * modelEta + 0.5 * observedEta : modelEta;
        emit({
            type: 'progress', stage: currentStage, overall, stageFraction: currentStageFraction, label: currentLabel,
            tile: currentTile, tiles: plan.tileCount, level: currentLevel, etaSeconds, bytesWritten: zipRef.zip?.bytesWritten
        });
    };

    // library log events → our progress
    const barWeights: Record<string, [number, number]> = {
        // decimation: [start, span] of the step
        'reading positions': [0, 0.08],
        'computing merge priorities': [0.08, 0.5],
        'merging': [0.58, 0.32],
        'Writing': [0.9, 0.1],
        // LOD writer
        'chunking': [0, 0.25]
    };
    let unitTotal = 0;
    logger.setRenderer({
        handle(e: LogEvent) {
            switch (e.kind) {
                case 'barTick':
                case 'barEnd': {
                    const w = barWeights[e.name];
                    if (w && e.total > 0) {
                        const f = w[0] + w[1] * Math.min(1, e.current / e.total);
                        if (f > currentStageFraction) currentStageFraction = f;
                        report();
                    }
                    break;
                }
                case 'scopeStart':
                    if (currentStage === 'encode' && e.index !== undefined && e.total !== undefined && /^\d+_\d+$/.test(e.name)) {
                        unitTotal = e.total;
                        currentStageFraction = Math.max(currentStageFraction, 0.25 + 0.75 * ((e.index - 1) / Math.max(1, unitTotal)));
                        currentLabel = `Tile ${currentTile + 1}/${plan.tileCount}: compressing chunk ${e.index}/${e.total}`;
                        report();
                    }
                    break;
                case 'message':
                    if (e.level === 'warn' || e.level === 'error') emit({ type: 'log', level: e.level, text: e.text });
                    break;
                default:
                    break;
            }
        }
    });

    const zip = new ZipWriter(env.output);
    zipRef.zip = zip;
    const merger = new LodMerger(zip);
    const pool = createChunkDataPool({ maxPooledBytes: 512 * 1024 * 1024 });
    const commentLines = modelComments(header);
    const actions: Parameters<typeof processSource>[1] = [];
    const [rx, ry, rz] = s.rotation ?? [0, 0, 0];
    const [tx, ty, tz] = s.translation ?? [0, 0, 0];
    const hasRot = Math.abs(rx) + Math.abs(ry) + Math.abs(rz) > 1e-9;
    const hasMove = Math.abs(tx) + Math.abs(ty) + Math.abs(tz) > 1e-9;
    const rotated = hasRot || hasMove;
    // order matters: rotate first, then move (both in engine space, like splat-transform -r then -t)
    if (hasRot) actions.push({ kind: 'rotate', value: new Vec3(rx, ry, rz) });
    if (hasMove) actions.push({ kind: 'translate', value: new Vec3(tx, ty, tz) });
    if (s.filterNaN) actions.push({ kind: 'filterNaN' });
    if (s.shBands >= 0 && s.shBands < header.shBands) actions.push({ kind: 'filterBands', value: s.shBands as 0 | 1 | 2 | 3 });
    const decimate = s.decimator === 'adaptive' ? decimateSourceAdaptive : decimateSource;
    const timings = { sample: (tSample - t0) / 1000, read: 0, decimate: 0, encode: 0, finalize: 0 };

    try {
        for (let g = 0; g < groups.length; g++) {
            const group = groups[g];
            checkAbort();

            // --- 3a. read pass
            currentStage = 'read';
            currentStageFraction = 0;
            stepWork = bodyBytes / readBps;
            currentLabel = groups.length > 1 ? `Reading the PLY (pass ${g + 1}/${groups.length})` : 'Reading the PLY';
            stage('read', currentLabel);
            report(true);
            const tr = performance.now();
            const stores = await routeGroup(env.input, header, plan, group, {
                signal: env.signal,
                onProgress: (done, total) => {
                    currentStageFraction = done / total;
                    report();
                }
            });
            const readSec = (performance.now() - tr) / 1000;
            timings.read += readSec;
            readBps = bodyBytes / Math.max(0.001, readSec);
            workDone += bodyBytes / readBps;

            // --- 3b. convert each tile of the group
            for (let gi = 0; gi < group.length; gi++) {
                checkAbort();
                const tile = group[gi];
                currentTile = tile;
                const tileStart = performance.now();
                if (stores[gi].count === 0) {
                    stores[gi].release();
                    continue;
                }
                // Z-order the tile once: the decimator and the LOD writer read by spatial blocks
                const store = mortonReorderStore(stores[gi]);
                stores[gi].release();

                // level 0: the tile's own splats as an in-memory PLY
                const l0Raw = await readPly(new SegmentReadSource([buildPlyHeader(store.count, kept, commentLines), ...store.segments()]), pool);
                const processed = actions.length > 0 ? await processSource(l0Raw, actions, pool, { createDevice: env.createDevice }) : l0Raw;
                // bake the user's rotation into the data, labelled PLY space like every other level,
                // so decimated levels, stackLods and the LOD writer all see one coordinate space
                const l0 = rotated ? bakeTransform(processed, Transform.PLY) : processed;
                const levels: ChunkSource[] = [l0];
                const memFs = new MemoryFs();

                // coarser levels by decimation, each from the previous level
                for (let k = 1; k < levelsPlan.length; k++) {
                    checkAbort();
                    const prev = levels[k - 1];
                    const n = prev.meta.numGaussians;
                    const target = Math.max(1, Math.round(n * s.lodRatio));
                    currentStage = 'decimate';
                    currentLevel = k;
                    currentStageFraction = 0;
                    stepWork = n * decPer;
                    currentLabel = `Tile ${tile + 1}/${plan.tileCount}: building level ${k} of ${levelsPlan.length - 1} (${fmt(n)} → ${fmt(target)} splats)`;
                    stage('decimate', currentLabel);
                    report(true);
                    const td = performance.now();
                    const dec = await decimate(prev, pool, {
                        targetCount: target,
                        createDevice: env.createDevice,
                        memoryBudgetBytes: Math.max(2 * 1024 ** 3, Math.floor(0.4 * s.memoryBytes))
                    });
                    const name = `/level${k}.ply`;
                    await writeSource({ filename: name, outputFormat: 'ply', source: dec, pool, options: {} }, memFs);
                    if (dec !== prev) await dec.close();
                    memFs.files.set(name, mortonReorderPly(memFs.files.get(name)!));
                    levels.push(await readPly(memFs.source(name), pool));
                    const dsec = (performance.now() - td) / 1000;
                    timings.decimate += dsec;
                    workDone += stepWork;
                    stepWork = 0;
                    // calibrate: blend measured rate in
                    decPer = 0.5 * decPer + 0.5 * (dsec / Math.max(1, n));
                }

                // LOD writer for this tile → files stream into the zip via the merger
                checkAbort();
                currentStage = 'encode';
                currentLevel = undefined;
                currentStageFraction = 0;
                const tileTotal = levels.reduce((a, l) => a + l.meta.numGaussians, 0);
                stepWork = tileTotal * encPer;
                currentLabel = `Tile ${tile + 1}/${plan.tileCount}: building the LOD tree`;
                stage('encode', currentLabel);
                report(true);
                const te = performance.now();
                const main = levels.length === 1 ? levels[0] : stackLods(levels);
                const fs = merger.tileFs(tile, '/out/');
                await writeLodSource({
                    filename: '/out/lod-meta.json',
                    mainSource: main,
                    envSource: null,
                    iterations: s.iterations,
                    webpEffort: s.webpEffort ?? undefined,
                    createDevice: env.createDevice,
                    chunkCount: s.chunkCount,
                    chunkExtent: s.chunkExtent,
                    chunkMin: s.chunkMin
                }, fs);
                fs.done();
                await main.close();
                for (const l of levels) await l.close();
                const esec = (performance.now() - te) / 1000;
                timings.encode += esec;
                workDone += stepWork;
                stepWork = 0;
                encPer = 0.5 * encPer + 0.5 * (esec / Math.max(1, tileTotal));

                store.release();
                memFs.files.clear();
                pool.trim(0);
                emit({ type: 'tileDone', tile, tiles: plan.tileCount, counts: levels.map(l => l.meta.numGaussians), seconds: (performance.now() - tileStart) / 1000 });
                emit({ type: 'log', level: 'info', text: `Tile ${tile + 1}/${plan.tileCount} done: ${levels.map(l => fmt(l.meta.numGaussians)).join(' / ')} splats in ${((performance.now() - tileStart) / 1000).toFixed(0)} s` });
            }
            // a group's stores are released tile by tile above
        }

        // --- 4. finalize: scene lod-meta.json, central directory
        checkAbort();
        currentStage = 'finalize';
        currentLabel = 'Writing lod-meta.json and closing the archive';
        stage('finalize', currentLabel);
        report(true);
        const tf = performance.now();
        const meta = merger.buildMeta(plan, {
            generator: `splat-transform v${stVersion} via shramko-sog-lod-converter v${CONVERTER_VERSION}`,
            chunkGaussians: s.chunkCount * 1024,
            chunkExtent: s.chunkExtent,
            chunkMinGaussians: s.chunkMin * 1024
        });
        await zip.add('lod-meta.json', serializeMeta(meta));
        await zip.finish();
        timings.finalize = (performance.now() - tf) / 1000;
        pool.destroy();

        return {
            meta,
            counts: meta.counts,
            archiveBytes: zip.bytesWritten,
            entries: zip.entryCount,
            seconds: (performance.now() - t0) / 1000,
            tiles: plan.tileCount,
            timings
        };
    } catch (err) {
        logger.unwindAll(true);
        await zip.abort(err).catch(() => undefined);
        pool.destroy();
        throw err;
    }
};

const fmt = (n: number) => {
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
    return `${n}`;
};

export { CONVERTER_VERSION, DEFAULT_SETTINGS, planLevels, previewPlan } from './plan';
export type { ConvertSettings, PlanInfo, Stage } from './plan';
