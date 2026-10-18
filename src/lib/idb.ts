/**
 * The one connection to the app's database (`wavelocal`): `tracks` (audio blobs and their metadata) and `meta` (order,
 * playlists, the resume point, and the derived-data caches under prefixed keys). It is a module of its own so that code loaded
 * on demand can open the database without pulling in the track-record code of `db.ts`.
 *
 * The version stays 1 on purpose: an old window that is still open (the update flow keeps old windows open until they are
 * reloaded) would block an upgrade, and the library would not load in the new one. New kinds of data therefore go under new
 * keys of `meta`, which old code simply never reads.
 *
 * The connection is not kept for ever. The browser closes it when site data is cleared or storage fails (`close`), and another
 * context that wants to upgrade or delete the database asks every connection to go (`versionchange`): in both cases the cached
 * connection is dropped and the next use opens a new one. A connection that died without telling anyone is found out when a
 * transaction is started on it (see `transaction`).
 */
const DB_NAME = 'wavelocal'
let dbPromise: Promise<IDBDatabase> | null = null
let current: IDBDatabase | null = null

/** Drop the cached connection, if it is `db` (a late report from one that was already replaced changes nothing). */
function forget(db: IDBDatabase): void {
  if (current !== db) return
  current = null
  dbPromise = null
}

export function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'))
    const r = indexedDB.open(DB_NAME, 1)
    r.onupgradeneeded = () => {
      const d = r.result
      if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta')
    }
    r.onsuccess = () => {
      const db = r.result
      current = db
      db.onclose = () => forget(db)
      db.onversionchange = () => {
        db.close()
        forget(db)
      }
      resolve(db)
    }
    r.onerror = () => reject(r.error)
  })
  dbPromise = p
  p.catch(() => {
    if (dbPromise === p) dbPromise = null
  })
  return p
}

/**
 * A transaction on the shared connection. If the connection turns out to be closed (the browser closed it and no event reached
 * us), a new one is opened and the transaction is started on that, once; any other error is the caller's.
 */
export async function transaction(store: 'tracks' | 'meta', mode: IDBTransactionMode): Promise<IDBTransaction> {
  const db = await open()
  try {
    return db.transaction(store, mode)
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'InvalidStateError')) throw error
    forget(db)
    return (await open()).transaction(store, mode)
  }
}
