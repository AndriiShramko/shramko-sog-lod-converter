// One tab at a time does the work. Two tabs converting at once compete for memory, and two tabs
// sharing one saved queue would convert the same files twice and overwrite each other's results.
// The tab that has work (a conversion, or a queue with files) holds a Web Lock; another tab sees
// the lock taken and stays read-only. A closed or crashed tab releases the lock automatically.

const NAME = 'shramko-sog-converter-work';

let held = false;
let release: (() => void) | null = null;
let pending: Promise<boolean> | null = null;

type Locks = { request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | undefined): Promise<unknown> };

export const holdsLock = () => held;

/** Try to become the working tab. Resolves false when another tab holds the lock. */
export const acquire = (): Promise<boolean> => {
    if (held) return Promise.resolve(true);
    if (pending) return pending;
    const locks = (navigator as unknown as { locks?: Locks }).locks;
    if (!locks?.request) {
        held = true; // no Web Locks (very old browser): behave as before, one tab assumed
        return Promise.resolve(true);
    }
    pending = new Promise<boolean>((resolve) => {
        locks.request(NAME, { ifAvailable: true }, (lock) => {
            if (!lock) {
                resolve(false);
                return undefined;
            }
            held = true;
            resolve(true);
            // keep the lock until released (or the tab goes away)
            return new Promise<void>((r) => {
                release = () => {
                    held = false;
                    release = null;
                    r();
                };
            });
        }).catch(() => {
            held = true;
            resolve(true);
        });
    }).finally(() => {
        pending = null;
    });
    return pending;
};

/** Give the lock up (nothing left to do in this tab). */
export const releaseLock = () => release?.();
