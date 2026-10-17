import type { TagChanges } from './id3write'
import type { TrackRecord } from '../types'

/** What the tag editor submits. `cover`: undefined keeps the artwork, null removes it, a Blob replaces it. */
export interface TagEdit {
  title: string
  artist: string
  album: string
  cover?: Blob | null
}

export const MAX_FIELD_LENGTH = 300
/** Embedded artwork above this size is refused (it would bloat every copy of the file). */
export const MAX_COVER_BYTES = 8 * 1024 * 1024

const IMAGE_SIGNATURES: readonly (readonly [mime: string, sig: readonly number[], offset: number])[] = [
  ['image/jpeg', [0xff, 0xd8, 0xff], 0],
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0],
  ['image/gif', [0x47, 0x49, 0x46, 0x38], 0],
  ['image/webp', [0x57, 0x45, 0x42, 0x50], 8],
]

/** Identify an image by its magic bytes (never trusting the file name or declared type), or null when unsupported. */
export function sniffImageMime(head: Uint8Array): string | null {
  for (const [mime, sig, offset] of IMAGE_SIGNATURES) {
    if (!sig.every((b, i) => head[offset + i] === b)) continue
    if (mime === 'image/webp' && String.fromCharCode(...head.subarray(0, 4)) !== 'RIFF') continue
    return mime
  }
  return null
}

/** Collapse whitespace, strip control characters and cap the length of a text field. */
export function cleanField(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FIELD_LENGTH)
}

export type CoverCheck = { ok: true; mime: string; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: string }

/** Validate an artwork file chosen by the user and read it. */
export async function readCover(file: Blob): Promise<CoverCheck> {
  if (file.size === 0) return { ok: false, reason: 'That image is empty' }
  if (file.size > MAX_COVER_BYTES) return { ok: false, reason: 'That image is larger than 8 MB' }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mime = sniffImageMime(bytes)
  if (!mime) return { ok: false, reason: 'Use a JPEG, PNG, GIF or WebP image' }
  return { ok: true, mime, bytes }
}

const stripExt = (n: string): string => n.replace(/\.[^.]+$/, '')

/** The values a record shows after an edit: blanks fall back exactly like they do at import. */
export function resolveFields(edit: Pick<TagEdit, 'title' | 'artist' | 'album'>, fileName: string): { title: string; artist: string; album: string } {
  return {
    title: cleanField(edit.title) || stripExt(fileName),
    artist: cleanField(edit.artist) || 'Unknown Artist',
    album: cleanField(edit.album),
  }
}

export interface TagEditResult {
  record: TrackRecord
  /** True when the tags were also written into the stored audio file (MP3 only). */
  embedded: boolean
  /** True when the cover blob changed. */
  coverChanged: boolean
}

/**
 * Apply an edit to a track record. The library fields always change; the stored audio copy is rewritten as well when it
 * is an MP3, so the tags travel with the file ("Download copy"). The record's dedupe `key` is kept so re-importing the
 * original file does not create a duplicate. Throws with a readable message when the cover is unusable.
 */
export async function applyTagEdit(record: TrackRecord, edit: TagEdit): Promise<TagEditResult> {
  const fields = resolveFields(edit, record.file.name)
  let coverBlob = record.coverBlob
  let picture: TagChanges['picture']
  let coverChanged = false

  if (edit.cover === null) {
    coverChanged = coverBlob !== null
    coverBlob = null
    picture = null
  } else if (edit.cover) {
    const checked = await readCover(edit.cover)
    if (!checked.ok) throw new Error(checked.reason)
    coverBlob = new Blob([checked.bytes], { type: checked.mime })
    picture = { mime: checked.mime, data: checked.bytes }
    coverChanged = true
  }

  let file = record.file
  let embedded = false
  const bytes = new Uint8Array(await record.file.arrayBuffer())
  // the tag writer is only needed by someone editing tags: its code is fetched then, not at startup
  const { isMp3, rewriteId3 } = await import('./id3write')
  if (isMp3(bytes)) {
    // a blank field removes the frame from the file instead of writing the display fallback into it
    const changes: TagChanges = {
      title: cleanField(edit.title),
      artist: cleanField(edit.artist),
      album: cleanField(edit.album),
    }
    if (picture !== undefined) changes.picture = picture
    const out = rewriteId3(bytes, changes)
    file = new File([out], record.file.name, { type: record.file.type || 'audio/mpeg', lastModified: record.file.lastModified })
    embedded = true
  }

  return { record: { ...record, ...fields, file, coverBlob }, embedded, coverChanged }
}
