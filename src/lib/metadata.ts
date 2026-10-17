import type { Lyrics, Track, TrackRecord } from '../types'
import { cleanFolderPath } from './folders'
import { parseLrc } from './lrc'
import { normalizeMeta } from './trackmeta'

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/i
const LRC_EXT = /\.lrc$/i

export const isAudioFile = (f: File): boolean => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name)
export const isLrcFile = (f: File): boolean => LRC_EXT.test(f.name)
/** A playlist file (M3U, M3U8, PLS) by its name: read into a playlist instead of being added as music. */
export const isPlaylistFile = (name: string): boolean => /\.(m3u8?|pls)$/i.test(name)

export const stripExt = (n: string): string => n.replace(/\.[^.]+$/, '')
/** Normalised name used to pair "Song.mp3" with "song.lrc". */
export const norm = (n: string): string => stripExt(n).trim().toLowerCase()
export const fileKey = (f: File): string => `${f.name}|${f.size}|${f.lastModified}`
/** The path a file was picked or dropped with (`Music/Rock/a.mp3`); '' for individually chosen files. */
export const relativePathOf = (f: File): string => f.webkitRelativePath || ''
export const newId = (): string => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

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
 * Records saved by an older version lack some fields (folder, play counts, analysis details): they are filled in here.
 * `reuse` is the track this one replaces: the copy shares its object URLs, so a patched track keeps playing and showing
 * its artwork without anything being minted again or revoked.
 */
export function buildTrack(rec: TrackRecord, reuse?: object): Track {
  const made: MintedUrls = (reuse && minted.get(reuse)) || {}
  const track = { ...rec, ...normalizeMeta(rec), path: cleanFolderPath(rec.path), addedAt: rec.addedAt || 0, plays: rec.plays || 0, lastPlayedAt: rec.lastPlayedAt ?? null } as Track
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

/** Free a track's object URLs; for a lazily built track only the ones it actually created. */
export function revokeTrack(t: Pick<Track, 'url' | 'cover'>): void {
  const made = minted.get(t)
  const urls = made ? [made.url, made.cover] : [t.url, t.cover]
  for (const u of urls) if (u) URL.revokeObjectURL(u)
}
