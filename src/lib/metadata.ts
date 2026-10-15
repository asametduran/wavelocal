import jsmediatags from 'jsmediatags/dist/jsmediatags.min.js'
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

function readTags(file: File): Promise<Tags> {
  return new Promise((resolve) => {
    try {
      jsmediatags.read(file, { onSuccess: (r) => resolve(r.tags || {}), onError: () => resolve({}) })
    } catch {
      resolve({})
    }
  })
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

/** Add object URLs to a persisted/new record so the audio element and <img> can use it. */
export function buildTrack(rec: TrackRecord): Track {
  return {
    ...rec,
    path: cleanFolderPath(rec.path), // records saved before the folder view have no path
    url: URL.createObjectURL(rec.file),
    cover: rec.coverBlob ? URL.createObjectURL(rec.coverBlob) : null,
  }
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

export function revokeTrack(t: Pick<Track, 'url' | 'cover'>): void {
  URL.revokeObjectURL(t.url)
  if (t.cover) URL.revokeObjectURL(t.cover)
}
