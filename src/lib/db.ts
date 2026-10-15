import type { MetaValues, TrackRecord } from '../types'

/** Tiny IndexedDB wrapper: `tracks` (audio blobs + metadata) and `meta` (order, playlists, resume point). */
const DB_NAME = 'wavelocal'
let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
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

function run<T = undefined>(store: 'tracks' | 'meta', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        t.oncomplete = () => resolve((req ? req.result : undefined) as T)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

/** Plain, structured-clone-safe record for a track (drops object URLs and any other in-memory fields). */
export const toRecord = (t: TrackRecord): TrackRecord => ({
  id: t.id,
  key: t.key,
  file: t.file,
  path: t.path || '',
  coverBlob: t.coverBlob || null,
  title: t.title,
  artist: t.artist,
  album: t.album,
  duration: t.duration || 0,
  lyrics: t.lyrics || null,
  gainDb: t.gainDb ?? null,
})

export const putTracks = (tracks: TrackRecord[]): Promise<void> =>
  run('tracks', 'readwrite', (s) => {
    tracks.forEach((t) => s.put(toRecord(t)))
  })
export const getAllTracks = (): Promise<TrackRecord[]> => run<TrackRecord[]>('tracks', 'readonly', (s) => s.getAll())
export const deleteTrack = (id: string): Promise<void> => run('tracks', 'readwrite', (s) => s.delete(id))
export const clearTracks = (): Promise<void> => run('tracks', 'readwrite', (s) => s.clear())
export const setMeta = <K extends keyof MetaValues>(key: K, value: MetaValues[K]): Promise<void> =>
  run('meta', 'readwrite', (s) => s.put(value, key))
export const getMeta = <K extends keyof MetaValues>(key: K): Promise<MetaValues[K] | undefined> =>
  run<MetaValues[K] | undefined>('meta', 'readonly', (s) => s.get(key))
