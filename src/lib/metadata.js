import jsmediatags from 'jsmediatags/dist/jsmediatags.min.js'
import { parseLrc } from './lrc'

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/i
const LRC_EXT = /\.lrc$/i

export const isAudioFile = (f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name)
export const isLrcFile = (f) => LRC_EXT.test(f.name)

const stripExt = (n) => n.replace(/\.[^.]+$/, '')
/** Normalised name used to pair "Song.mp3" with "song.lrc". */
export const norm = (n) => stripExt(n).trim().toLowerCase()
export const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`
const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

function readTags(file) {
  return new Promise((resolve) => {
    try {
      jsmediatags.read(file, { onSuccess: (r) => resolve(r.tags || {}), onError: () => resolve({}) })
    } catch {
      resolve({})
    }
  })
}

function pictureBlob(picture) {
  if (!picture?.data?.length) return null
  return new Blob([new Uint8Array(picture.data)], { type: picture.format || 'image/jpeg' })
}

/** Add object URLs to a persisted/new record so the audio element and <img> can use it. */
export function buildTrack(rec) {
  return {
    ...rec,
    url: URL.createObjectURL(rec.file),
    cover: rec.coverBlob ? URL.createObjectURL(rec.coverBlob) : null,
  }
}

export async function lrcFromFile(file) {
  try {
    return parseLrc(await file.text())
  } catch {
    return null
  }
}

async function fileToTrack(file, lrcMap) {
  const tags = await readTags(file)
  const title = (tags.title || '').trim() || stripExt(file.name)
  const artist = (tags.artist || '').trim() || 'Unknown Artist'
  const embedded = tags.lyrics?.lyrics ?? (typeof tags.lyrics === 'string' ? tags.lyrics : '')
  const lyrics =
    lrcMap.get(norm(file.name)) || lrcMap.get(title.toLowerCase()) || lrcMap.get(`${artist} - ${title}`.toLowerCase()) || parseLrc(embedded) || null
  return buildTrack({
    id: newId(),
    key: fileKey(file),
    file,
    coverBlob: pictureBlob(tags.picture),
    title,
    artist,
    album: (tags.album || '').trim(),
    duration: 0,
    lyrics,
  })
}

/**
 * Turn picked/dropped files into tracks. `.lrc` files are paired by name (or title) with audio files.
 * Returns the new tracks plus any `.lrc` files that matched nothing (so the caller can attach them to existing tracks).
 */
export async function filesToTracks(fileList, existingKeys = new Set()) {
  const all = Array.from(fileList)
  const audio = all.filter(isAudioFile).filter((f) => !existingKeys.has(fileKey(f)))
  audio.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  const lrcMap = new Map()
  const lrcFiles = []
  for (const f of all.filter(isLrcFile)) {
    const lyrics = await lrcFromFile(f)
    if (lyrics) lrcFiles.push({ name: f.name, lyrics })
  }
  lrcFiles.forEach((l) => lrcMap.set(norm(l.name), l.lyrics))

  const tracks = await Promise.all(audio.map((f) => fileToTrack(f, lrcMap)))
  const used = new Set(tracks.filter((t) => t.lyrics).map((t) => t.lyrics))
  const orphanLrc = lrcFiles.filter((l) => !used.has(l.lyrics))
  return { tracks, orphanLrc }
}

export function revokeTrack(t) {
  URL.revokeObjectURL(t.url)
  if (t.cover) URL.revokeObjectURL(t.cover)
}
