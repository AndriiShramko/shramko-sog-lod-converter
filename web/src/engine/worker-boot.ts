// Worker entry. PlayCanvas (pulled in by splat-transform) reads `window.navigator.gpu`, and a
// worker has no `window`, so alias it before the engine modules load — which means the real
// worker has to be imported dynamically, after this line runs.
(self as unknown as { window: unknown }).window ??= self;

// Queue messages that arrive while the engine module is still loading.
const early: MessageEvent[] = [];
const hold = (e: MessageEvent) => early.push(e);
self.addEventListener('message', hold);

import('./worker').then(({ handleMessage }) => {
    self.removeEventListener('message', hold);
    self.addEventListener('message', handleMessage);
    for (const e of early) handleMessage(e);
}).catch((err: unknown) => {
    const e = err as Error;
    self.postMessage({
        type: 'error',
        error: { name: e?.name ?? 'Error', message: `The converter failed to load: ${e?.message ?? String(err)}`, stack: e?.stack },
        stage: 'header',
        detail: 'loading the converter',
        cancelled: false
    });
});
