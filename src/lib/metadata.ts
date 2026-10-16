import type { Picture, Tags, TxxxFrame, TxxxPayload } from 'jsmediatags/dist/jsmediatags.min.js'
import type { Lyrics, Track, TrackRecord } from '../types'
import { parseLrc } from './lrc'
import { cleanFolderPath, folderOf } from './folders'

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/i
const LRC_EXT = /\.lrc$/i

/** An `.lrc` file that parsed but matched no imported audio file. */
export interface OrphanLrc {
  name: string
  lyrics: Lyrics
}

export const isAudioFile = (f: File): boolean => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name)
export const isLrcFile = (f: File): boolean => LRC_EXT.test(f.name)

const stripExt = (n: string): string => n.replace(/\.[^.]+$/, '')
/** Normalised name used to pair "Song.mp3" with "song.lrc". */
export const norm = (n: string): string => stripExt(n).trim().toLowerCase()
export const fileKey = (f: File): string => `${f.name}|${f.size}|${f.lastModified}`
/** The path a file was picked or dropped with (`Music/Rock/a.mp3`); '' for individually chosen files. */
export const relativePathOf = (f: File): string => f.webkitRelativePath || ''
const newId = (): string => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** The tag reader is only needed once files are imported, so it loads on demand instead of weighing down startup. */
let tagReader: Promise<typeof import('jsmediatags/dist/jsmediatags.min.js').default> | null = null
const loadTagReader = () => (tagReader ??= import('jsmediatags/dist/jsmediatags.min.js').then((m) => m.default))

async function readTags(file: File): Promise<Tags> {
  try {
    const jsmediatags = await loadTagReader()
    return await new Promise<Tags>((resolve) => {
      jsmediatags.read(file, { onSuccess: (r) => resolve(r.tags || {}), onError: () => resolve({}) })
    })
  } catch {
    return {}
  }
}

function pictureBlob(picture: Picture | undefined): Blob | null {
  if (!picture?.data?.length) return null
  return new Blob([Uint8Array.from(picture.data)], { type: picture.format || 'image/jpeg' })
}

/** Unwrap a TXXX frame to its `{ user_description, data }` payload. */
function txxxPayload(frame: TxxxFrame): TxxxPayload {
  const inner = frame.data
  return inner !== null && typeof inner === 'object' ? inner : (frame as TxxxPayload)
}

/** ReplayGain track (or album) gain in dB from ID3v2 TXXX frames, or null when absent/invalid. */
export function replayGainDb(tags: Tags | null | undefined): number | null {
  const raw = tags?.TXXX
  const frames = (Array.isArray(raw) ? raw : [raw]).filter((f): f is TxxxFrame => Boolean(f))
  const found: Record<string, string> = {}
  for (const f of frames) {
    const d = txxxPayload(f)
    const name = String(d.user_description || '').trim().toLowerCase().replace(/\0/g, '')
    if (name === 'replaygain_track_gain' || name === 'replaygain_album_gain') found[name] = String(d.data || '')
  }
  const m = (found.replaygain_track_gain ?? found.replaygain_album_gain ?? '').match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const db = parseFloat(m[0])
  return Number.isFinite(db) ? Math.round(Math.max(-12, Math.min(12, db)) * 10) / 10 : null
}

/** Object URLs a lazy track has created so far (so revoking never creates one just to free it). */
interface MintedUrls {
  url?: string
  cover?: string
}
const minted = new WeakMap<object, MintedUrls>()

/**
 * Add object URLs to a persisted/new record so the audio element and <img> can use it.
 * The URLs are minted on first read: a 10,000-track library registers a handful of blob URLs (the rows on screen and
 * the playing track) instead of 20,000 at startup. Reading `url` or `cover` is otherwise indistinguishable from a
 * plain property; spreading a track mints both, and the copy is then an ordinary object.
 */
export function buildTrack(rec: TrackRecord): Track {
  const made: MintedUrls = {}
  // records saved before the folder view / play counts existed lack those fields
  const track = { ...rec, path: cleanFolderPath(rec.path), addedAt: rec.addedAt || 0, plays: rec.plays || 0, lastPlayedAt: rec.lastPlayedAt ?? null } as Track
  Object.defineProperties(track, {
    url: {
      enumerable: true,
      configurable: true,
      get: () => (made.url ??= URL.createObjectURL(rec.file)),
    },
    cover: {
      enumerable: true,
      configurable: true,
      get: () => (rec.coverBlob ? (made.cover ??= URL.createObjectURL(rec.coverBlob)) : null),
    },
  })
  minted.set(track, made)
  return track
}

export async function lrcFromFile(file: Blob): Promise<Lyrics | null> {
  try {
    return parseLrc(await file.text())
  } catch {
    return null
  }
}

async function fileToTrack(file: File, lrcMap: ReadonlyMap<string, Lyrics>): Promise<Track> {
  const tags = await readTags(file)
  const title = (tags.title || '').trim() || stripExt(file.name)
  const artist = (tags.artist || '').trim() || 'Unknown Artist'
  const embedded = typeof tags.lyrics === 'string' ? tags.lyrics : (tags.lyrics?.lyrics ?? '')
  const lyrics =
    lrcMap.get(norm(file.name)) || lrcMap.get(title.toLowerCase()) || lrcMap.get(`${artist} - ${title}`.toLowerCase()) || parseLrc(embedded) || null
  return buildTrack({
    id: newId(),
    key: fileKey(file),
    file,
    path: folderOf(relativePathOf(file)),
    coverBlob: pictureBlob(tags.picture),
    title,
    artist,
    album: (tags.album || '').trim(),
    duration: 0,
    lyrics,
    gainDb: replayGainDb(tags),
    addedAt: Date.now(),
    plays: 0,
    lastPlayedAt: null,
  })
}

/**
 * Turn picked/dropped files into tracks. `.lrc` files are paired by name (or title) with audio files.
 * Returns the new tracks plus any `.lrc` files that matched nothing (so the caller can attach them to existing tracks).
 */
export async function filesToTracks(
  fileList: Iterable<File> | ArrayLike<File>,
  existingKeys: ReadonlySet<string> = new Set(),
): Promise<{ tracks: Track[]; orphanLrc: OrphanLrc[] }> {
  const all = Array.from(fileList)
  const audio = all.filter(isAudioFile).filter((f) => !existingKeys.has(fileKey(f)))
  audio.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  const lrcMap = new Map<string, Lyrics>()
  const lrcFiles: OrphanLrc[] = []
  for (const f of all.filter(isLrcFile)) {
    const lyrics = await lrcFromFile(f)
    if (lyrics) lrcFiles.push({ name: f.name, lyrics })
  }
  lrcFiles.forEach((l) => lrcMap.set(norm(l.name), l.lyrics))

  const tracks = await Promise.all(audio.map((f) => fileToTrack(f, lrcMap)))
  const used = new Set(tracks.flatMap((t) => (t.lyrics ? [t.lyrics] : [])))
  const orphanLrc = lrcFiles.filter((l) => !used.has(l.lyrics))
  return { tracks, orphanLrc }
}

/** Free a track's object URLs; for a lazily built track only the ones it actually created. */
export function revokeTrack(t: Pick<Track, 'url' | 'cover'>): void {
  const made = minted.get(t)
  const urls = made ? [made.url, made.cover] : [t.url, t.cover]
  for (const u of urls) if (u) URL.revokeObjectURL(u)
}
