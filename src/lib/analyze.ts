import type { Picture, Tags, TxxxFrame, TxxxPayload } from 'jsmediatags/dist/jsmediatags.min.js'
import type { TrackMeta } from '../types'
import { probeAudio } from './audio/probe'
import { readId3Text } from './audio/probe/id3'
import type { ProbeResult, TagValues } from './audio/probe/types'
import { blobSource } from './audio/source'
import { note } from './diagnostics/capture'
import { fieldsFromTagValues, parseGainDb, tagValuesFromJsmediatags } from './tagfields'

/**
 * Everything the library learns about an audio file in one pass: the container probe (format, duration, and the tags
 * of Ogg, FLAC and WAV, which it reads itself) plus jsmediatags for MP3 and MP4 tags. Never throws: a file nobody can
 * read analyses as "unknown", and the track still gets imported under its file name.
 */

export interface Analysis {
  /** Raw tag text; empty when the file has none (the importer falls back to the file name and "Unknown Artist"). */
  title: string
  artist: string
  album: string
  /** The sorting and searching fields, and what the container headers say about the audio. */
  meta: Omit<TrackMeta, 'indexed'>
  /** Seconds; 0 when nothing could say. */
  duration: number
  cover: Blob | null
  /** Lyrics found in the tags, as LRC or plain text. */
  lyricsText: string
  /** ReplayGain track (else album) gain in dB, or null. */
  gainDb: number | null
}

export interface AnalyzeDeps {
  /** The tag reader for MP3 and MP4; replaceable for tests. */
  readTags?: (file: Blob) => Promise<Tags>
  /** Last resort for a duration no probe could read (see `measureMediaDuration`). Left out, an unreadable duration is 0. */
  mediaDuration?: (file: Blob) => Promise<number | null>
}

/** The tag reader is only needed once files are imported, so it loads on demand instead of weighing down startup. */
let tagReader: Promise<typeof import('jsmediatags/dist/jsmediatags.min.js').default> | null = null
const loadTagReader = () => (tagReader ??= import('jsmediatags/dist/jsmediatags.min.js').then((m) => m.default))

export async function readTags(file: Blob): Promise<Tags> {
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
  return parseGainDb(found.replaygain_track_gain ?? found.replaygain_album_gain)
}

/** Containers whose tags the probes read themselves (jsmediatags reads none of Ogg, little of FLAC, nothing of WAV). */
const OWN_TAGS = new Set(['flac', 'ogg', 'wav'])

export async function analyzeFile(file: Blob, deps: AnalyzeDeps = {}): Promise<Analysis> {
  let probed: ProbeResult | null = null
  try {
    probed = await probeAudio(blobSource(file))
  } catch (error) {
    note('decode')(error) // the probes answer null for a format they do not know; a throw is a file they could not take
    probed = null
  }

  let values: TagValues = probed?.tags ?? {}
  let cover = probed?.picture ?? null
  let gainDb: number | null = null
  if (probed && OWN_TAGS.has(probed.format.container)) {
    gainDb = parseGainDb(values.replayGain)
  } else {
    let tags: Tags = {}
    try {
      tags = await (deps.readTags ?? readTags)(file)
    } catch {
      tags = {}
    }
    values = tagValuesFromJsmediatags(tags)
    cover = pictureBlob(tags.picture)
    gainDb = replayGainDb(tags)
    if (probed?.format.container !== 'mp4') {
      // jsmediatags strips the numeric reference from a genre like "(13)" and leaves nothing: read the raw frame instead
      try {
        const raw = await readId3Text(blobSource(file), ['TCON', 'TCO'])
        const genre = raw.get('TCON') ?? raw.get('TCO')
        if (genre) values = { ...values, genre }
      } catch {
        // keep whatever jsmediatags found
      }
    }
  }

  let duration = probed?.duration ?? null
  if (duration === null && deps.mediaDuration) {
    try {
      duration = await deps.mediaDuration(file)
    } catch {
      duration = null
    }
  }

  return {
    title: values.title ?? '',
    artist: values.artist ?? '',
    album: values.album ?? '',
    meta: { ...fieldsFromTagValues(values), audio: probed?.format ?? null },
    duration: duration !== null && Number.isFinite(duration) && duration > 0 ? duration : 0,
    cover,
    lyricsText: values.lyrics ?? '',
    gainDb,
  }
}
