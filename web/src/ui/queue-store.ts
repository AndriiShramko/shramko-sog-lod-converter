// Tiny IndexedDB key/value store for the queue. IndexedDB (not localStorage) because it can keep
// FileSystemHandles — the picked files and the output folder — across a reload, so an interrupted
// queue can resume after one "allow" click. Never store a File here: IndexedDB would copy it.

const DB = 'sog-queue';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;
const open = () => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    return dbPromise;
};

const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    });
};

export const idbGet = async <T>(key: string): Promise<T | undefined> => {
    try {
        return await tx<T>('readonly', s => s.get(key) as IDBRequest<T>);
    } catch {
        return undefined; // private mode / blocked storage: the queue still works, it just is not remembered
    }
};

export const idbSet = async (key: string, value: unknown): Promise<boolean> => {
    try {
        await tx('readwrite', s => s.put(value, key));
        return true;
    } catch (e) {
        console.warn('queue: could not save', e);
        return false;
    }
};

export const idbDel = async (key: string): Promise<void> => {
    try {
        await tx('readwrite', s => s.delete(key));
    } catch { /* ignore */ }
};
