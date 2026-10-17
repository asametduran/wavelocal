import { open } from './idb'

/**
 * The few operations the derived-data caches (waveforms, chapters, listening state) need from the app's database. They live
 * under prefixed keys of the existing `meta` store, so there is no new object store and the database version stays 1: an old
 * window that is still open would block an upgrade (the update flow keeps old windows open on purpose), and the library
 * would not load in the new one. The interface also lets the caches be tested with a `Map`.
 */
export interface KeyValue {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  /** Every key that starts with `prefix`. */
  keys(prefix: string): Promise<string[]>
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction('meta', mode)
        const request = fn(t.objectStore('meta'))
        t.oncomplete = () => resolve(request.result)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

export const idbKeyValue: KeyValue = {
  get: (key) => run('readonly', (s) => s.get(key)),
  set: (key, value) => run('readwrite', (s) => s.put(value, key)).then(() => undefined),
  delete: (key) => run('readwrite', (s) => s.delete(key)).then(() => undefined),
  // '￿' sorts after every character a key of ours uses, so this range is exactly the keys with the prefix
  keys: (prefix) => run('readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`))).then((keys) => keys.filter((key): key is string => typeof key === 'string')),
}
