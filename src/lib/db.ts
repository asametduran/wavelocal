import type { MetaValues, TrackRecord } from '../types'
import { open } from './idb'
import { normalizeMeta } from './trackmeta'

/** Tiny IndexedDB wrapper: `tracks` (audio blobs + metadata) and `meta` (order, playlists, resume point). The connection is `idb.ts`. */

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
  addedAt: t.addedAt || 0,
  plays: t.plays || 0,
  lastPlayedAt: t.lastPlayedAt ?? null,
  ...normalizeMeta(t),
})

export const putTracks = (tracks: TrackRecord[]): Promise<void> =>
  run('tracks', 'readwrite', (s) => {
    tracks.forEach((t) => s.put(toRecord(t)))
  })
/**
 * Merge a patch into stored records inside one transaction, so a background change can never overwrite what another
 * part of the app saved in between, and a record that has been removed since stays removed.
 */
export const patchTracks = (patches: ReadonlyMap<string, Partial<TrackRecord>>): Promise<void> =>
  open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction('tracks', 'readwrite')
        const store = t.objectStore('tracks')
        for (const [id, patch] of patches) {
          const req = store.get(id)
          req.onsuccess = () => {
            const stored = req.result as TrackRecord | undefined
            if (stored) store.put({ ...stored, ...patch })
          }
        }
        t.oncomplete = () => resolve()
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
export const getAllTracks = (): Promise<TrackRecord[]> => run<TrackRecord[]>('tracks', 'readonly', (s) => s.getAll())
export const deleteTrack = (id: string): Promise<void> => run('tracks', 'readwrite', (s) => s.delete(id))
export const clearTracks = (): Promise<void> => run('tracks', 'readwrite', (s) => s.clear())
export const setMeta = <K extends keyof MetaValues>(key: K, value: MetaValues[K]): Promise<void> =>
  run('meta', 'readwrite', (s) => s.put(value, key))
export const getMeta = <K extends keyof MetaValues>(key: K): Promise<MetaValues[K] | undefined> =>
  run<MetaValues[K] | undefined>('meta', 'readonly', (s) => s.get(key))
