/**
 * The one connection to the app's database (`wavelocal`): `tracks` (audio blobs and their metadata) and `meta` (order,
 * playlists, the resume point, and the derived-data caches under prefixed keys). It is a module of its own so that code loaded
 * on demand can open the database without pulling in the track-record code of `db.ts`.
 *
 * The version stays 1 on purpose: an old window that is still open (the update flow keeps old windows open until they are
 * reloaded) would block an upgrade, and the library would not load in the new one. New kinds of data therefore go under new
 * keys of `meta`, which old code simply never reads.
 */
const DB_NAME = 'wavelocal'
let dbPromise: Promise<IDBDatabase> | null = null

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
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  dbPromise = p
  p.catch(() => {
    dbPromise = null
  })
  return p
}
