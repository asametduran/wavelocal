import type { EqBand, LyricLine, Lyrics, Playlist, ResumePoint, TrackMeta, TrackRecord } from '../../types'
import { normalizeTrackEq } from '../eq'
import { MAX_LINES } from '../lrc'
import { cleanName } from '../playlists'
import { keepKnown } from '../upnext'

/**
 * What the library makes of the saved data on its way in. Everything the database hands over is read as untrusted: a version
 * of the app that is gone, a full disk or a damaged profile can leave any value odd, and one odd value that reached rendering
 * would blank the page on every start, because it is stored. Pure, so it is tested and fuzzed without a browser. A row that
 * cannot be used is skipped and counted, never deleted: the audio in it belongs to the person.
 */

/**
 * Repairs the analysis fields of a saved row (`normalizeMeta` of `lib/trackmeta.ts`). The caller hands it in instead of this module
 * importing it: this module is a lazy chunk, and `trackmeta` reaches `tags.ts`, which the start-up code and the tag editor already
 * share. A third importer makes the bundler cut `tags.ts` out of the start-up chunk into a file of its own, and that costs more than
 * the lines that would save.
 */
export type MetaNormalizer = (raw: unknown) => TrackMeta

/** The seven values of the database as they were read. */
export interface RawLibrary {
  rows: readonly unknown[]
  order: unknown
  playlists: unknown
  resume: unknown
  trackEq: unknown
  upNext: unknown
  pending: unknown
}

export interface Hydrated {
  /** The usable rows in the saved order: the order list first, then the rows it does not mention, in the order the database gave them. */
  records: TrackRecord[]
  /** Rows with no id or no audio file. They stay in the database. */
  skippedRows: number
  playlists: Playlist[]
  /** Entries of the saved playlist list that were not playlists. */
  skippedPlaylists: number
  resume: ResumePoint | null
  trackEq: Record<string, EqBand[]>
  /** The ids queued by hand that are still in the library. */
  upNext: string[]
  /** The saved pending restore, as it was: its validator belongs to the backup code. */
  pending: unknown
}

const MAX_LINE_CHARS = 2000
const DEFAULT_PLAYLIST_NAME = 'Playlist'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isFinite_ = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const count = (value: unknown): number => (isFinite_(value) && value >= 0 ? value : 0)
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Lyrics as the lyrics view needs them, or null: lines that are not text are dropped, a time that is not a time becomes none, lyrics without a time on every line are not synced. */
export function normalizeLyrics(raw: unknown): Lyrics | null {
  if (!isObject(raw) || !Array.isArray(raw.lines)) return null
  const lines: LyricLine[] = []
  for (const entry of raw.lines) {
    if (lines.length >= MAX_LINES) break
    if (!isObject(entry) || typeof entry.text !== 'string') continue
    lines.push({ t: isFinite_(entry.t) && entry.t >= 0 ? entry.t : null, text: entry.text.slice(0, MAX_LINE_CHARS) })
  }
  if (!lines.length) return null
  return { synced: raw.synced === true && lines.every((line) => line.t !== null), lines }
}

const stem = (fileName: string): string => fileName.replace(/\.[^./\\]*$/, '').trim()

/** A saved row made fit to use, or null when it has no id or no audio. Missing text becomes empty, a bad number becomes 0. */
export function normalizeRow(raw: unknown, meta: MetaNormalizer): TrackRecord | null {
  if (!isObject(raw)) return null
  const { id, file: stored } = raw
  if (typeof id !== 'string' || !id || !(stored instanceof Blob)) return null
  const storedKey = typeof raw.key === 'string' ? raw.key : ''
  // a Blob that is not a File (a record from an odd source) gets the name its key remembers, so nothing downstream finds `name` missing
  const file = stored instanceof File ? stored : new File([stored], storedKey.split('|')[0] || id, { type: stored.type })
  const title = textOf(raw.title)
  return {
    id,
    key: storedKey || `${file.name}|${file.size}|${file.lastModified}`,
    file,
    path: textOf(raw.path),
    coverBlob: raw.coverBlob instanceof Blob ? raw.coverBlob : null,
    title: title.trim() ? title : stem(file.name) || 'Untitled',
    artist: textOf(raw.artist),
    album: textOf(raw.album),
    duration: count(raw.duration),
    lyrics: normalizeLyrics(raw.lyrics),
    gainDb: isFinite_(raw.gainDb) ? raw.gainDb : null,
    addedAt: count(raw.addedAt),
    plays: count(raw.plays),
    lastPlayedAt: isFinite_(raw.lastPlayedAt) && raw.lastPlayedAt >= 0 ? raw.lastPlayedAt : null,
    ...meta(raw),
  }
}

/** The saved playlists that are playlists: an id (the first of its kind), a clean name, a list of track ids. Anything else is counted and left out. */
export function normalizePlaylists(raw: unknown): { playlists: Playlist[]; skipped: number } {
  if (!Array.isArray(raw)) return { playlists: [], skipped: 0 }
  const taken = new Set<string>()
  const playlists: Playlist[] = []
  let skipped = 0
  for (const entry of raw) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id || taken.has(entry.id)) {
      skipped++
      continue
    }
    taken.add(entry.id)
    const trackIds = Array.isArray(entry.trackIds) ? entry.trackIds.filter((trackId): trackId is string => typeof trackId === 'string' && trackId !== '') : []
    // what a newer version added to a playlist is carried along
    playlists.push({ ...entry, id: entry.id, name: cleanName(textOf(entry.name), DEFAULT_PLAYLIST_NAME), trackIds })
  }
  return { playlists, skipped }
}

/** The place the player left off, or null. */
export function normalizeResume(raw: unknown): ResumePoint | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id || !isFinite_(raw.time) || raw.time < 0) return null
  return { id: raw.id, time: raw.time }
}

export function hydrateLibrary(raw: RawLibrary, meta: MetaNormalizer): Hydrated {
  const byId = new Map<string, TrackRecord>()
  const rows: TrackRecord[] = []
  let skippedRows = 0
  for (const stored of raw.rows) {
    const row = normalizeRow(stored, meta)
    if (!row || byId.has(row.id)) {
      skippedRows++
      continue
    }
    byId.set(row.id, row)
    rows.push(row)
  }

  const listed = new Set<string>()
  const records: TrackRecord[] = []
  if (Array.isArray(raw.order)) {
    for (const id of raw.order) {
      const row = typeof id === 'string' ? byId.get(id) : undefined
      if (!row || listed.has(row.id)) continue
      listed.add(row.id)
      records.push(row)
    }
  }
  for (const row of rows) if (!listed.has(row.id)) records.push(row)

  const known = (id: string): boolean => byId.has(id)
  const { playlists, skipped: skippedPlaylists } = normalizePlaylists(raw.playlists)
  const trackEq = Object.fromEntries(Object.entries(normalizeTrackEq(raw.trackEq)).filter(([id]) => known(id)))
  return { records, skippedRows, playlists, skippedPlaylists, resume: normalizeResume(raw.resume), trackEq, upNext: keepKnown(raw.upNext, known), pending: raw.pending }
}
