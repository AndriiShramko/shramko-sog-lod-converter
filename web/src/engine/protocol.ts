// Messages between the page and the conversion worker.

import type { ConvertSettings, PipelineEvent, PipelineResult, Stage } from './pipeline';
import type { VerifyReport } from './verify';

export type OutputTarget =
    | { kind: 'fsa'; handle: FileSystemFileHandle }   // file the user picked with showSaveFilePicker
    | { kind: 'opfs'; name: string };                   // browser-private storage, downloaded afterwards

export interface StartMessage {
    type: 'start';
    file: File;
    output: OutputTarget;
    settings: ConvertSettings;
    useGpu: boolean;
    workers: number; // 0 = auto
}

export type ToWorker = StartMessage | { type: 'cancel' };

export interface WorkerErrorInfo {
    name: string;
    message: string;
    stack?: string;
    code?: string;
}

export type FromWorker =
    | { type: 'event'; ev: PipelineEvent }
    | { type: 'stage'; stage: Stage; detail: string }
    | { type: 'gpu'; ok: boolean; adapter?: string; error?: string }
    | { type: 'verifying'; fraction: number }
    | { type: 'result'; result: Omit<PipelineResult, 'meta'>; verify: VerifyReport; outputName: string }
    | { type: 'error'; error: WorkerErrorInfo; stage: Stage; detail: string; cancelled: boolean }
    | { type: 'heartbeat' };
