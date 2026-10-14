/** Tiny IndexedDB wrapper: `tracks` (audio blobs + metadata) and `meta` (order, playlists, resume point). */
const DB_NAME = 'wavelocal'
let dbPromise = null

function open() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
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
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
}

function run(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        t.oncomplete = () => resolve(req?.result)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

/** Plain, structured-clone-safe record for a track. */
export const toRecord = (t) => ({
  id: t.id,
  key: t.key,
  file: t.file,
  coverBlob: t.coverBlob || null,
  title: t.title,
  artist: t.artist,
  album: t.album,
  duration: t.duration || 0,
  lyrics: t.lyrics || null,
})

export const putTracks = (tracks) =>
  run('tracks', 'readwrite', (s) => {
    tracks.forEach((t) => s.put(toRecord(t)))
  })
export const getAllTracks = () => run('tracks', 'readonly', (s) => s.getAll())
export const deleteTrack = (id) => run('tracks', 'readwrite', (s) => s.delete(id))
export const clearTracks = () => run('tracks', 'readwrite', (s) => s.clear())
export const setMeta = (key, value) => run('meta', 'readwrite', (s) => s.put(value, key))
export const getMeta = (key) => run('meta', 'readonly', (s) => s.get(key))
