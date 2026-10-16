import { ascii, be32, le32 } from './source'
import type { TagValues } from './probe/types'

/**
 * Vorbis comments: the tag format of FLAC, Ogg Vorbis and Opus. A block is a vendor string followed by a list of
 * `NAME=value` entries, all UTF-8 with little-endian lengths. jsmediatags only reads a handful of these fields (and
 * none at all from Ogg), so the probes read them here. Everything is treated as untrusted input: lengths are checked
 * against the buffer, the entry count is capped and a damaged tail keeps what was read before it.
 */

export interface VorbisComments {
  vendor: string
  /** `[NAME, value]` pairs in file order, names upper-cased (the spec makes them case-insensitive). */
  fields: [string, string][]
}

const MAX_FIELDS = 5000
const utf8 = new TextDecoder('utf-8')

/** Artwork larger than this is not worth keeping: it would bloat the library record and every backup of the file. */
export const MAX_PICTURE_BYTES = 8 * 1024 * 1024

export function parseVorbisComments(bytes: Uint8Array, offset = 0): VorbisComments | null {
  if (offset < 0 || offset + 4 > bytes.length) return null
  const vendorLength = le32(bytes, offset)
  let pos = offset + 4
  if (pos + vendorLength > bytes.length) return null
  const vendor = utf8.decode(bytes.subarray(pos, pos + vendorLength))
  pos += vendorLength
  const fields: [string, string][] = []
  if (pos + 4 > bytes.length) return { vendor, fields }
  const count = le32(bytes, pos)
  pos += 4
  for (let i = 0; i < count && i < MAX_FIELDS; i++) {
    if (pos + 4 > bytes.length) break
    const length = le32(bytes, pos)
    pos += 4
    if (pos + length > bytes.length) break
    const entry = utf8.decode(bytes.subarray(pos, pos + length))
    pos += length
    const eq = entry.indexOf('=')
    if (eq > 0) fields.push([entry.slice(0, eq).toUpperCase(), entry.slice(eq + 1)])
  }
  return { vendor, fields }
}

/** "3" plus a separate total of "12" is "3/12"; a number that already carries its total is left alone. */
const withTotal = (n: string | undefined, total: string | undefined): string | undefined => (!n ? undefined : n.includes('/') || !total ? n : `${n}/${total}`)

export function tagsFromVorbis({ fields }: VorbisComments): TagValues {
  const all = (name: string): string[] =>
    fields
      .filter(([key]) => key === name)
      .map(([, value]) => value.trim())
      .filter(Boolean)
  const first = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = all(name)[0]
      if (value) return value
    }
    return undefined
  }
  const joined = (name: string): string | undefined => {
    const values = all(name)
    return values.length ? values.join(', ') : undefined
  }

  const out: TagValues = {}
  const set = (key: keyof TagValues, value: string | undefined): void => {
    if (value) out[key] = value
  }
  set('title', first('TITLE'))
  set('artist', joined('ARTIST'))
  set('album', first('ALBUM'))
  set('albumArtist', first('ALBUMARTIST', 'ALBUM ARTIST', 'ALBUM_ARTIST'))
  set('genre', joined('GENRE'))
  set('date', first('DATE', 'ORIGINALDATE', 'YEAR'))
  set('track', withTotal(first('TRACKNUMBER', 'TRACK'), first('TRACKTOTAL', 'TOTALTRACKS')))
  set('disc', withTotal(first('DISCNUMBER', 'DISC'), first('DISCTOTAL', 'TOTALDISCS')))
  set('compilation', first('COMPILATION'))
  set('lyrics', first('LYRICS', 'UNSYNCEDLYRICS'))
  set('replayGain', first('REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_ALBUM_GAIN'))
  return out
}

/** Where the image sits inside a FLAC PICTURE block. */
export interface PictureRef {
  mime: string
  /** The ID3v2 picture type: 3 is the front cover. */
  kind: number
  start: number
  length: number
}

/** Read a FLAC PICTURE block (also the payload of an Ogg `METADATA_BLOCK_PICTURE` comment). */
export function parseFlacPicture(b: Uint8Array): PictureRef | null {
  if (b.length < 32) return null
  const kind = be32(b, 0)
  const mimeLength = be32(b, 4)
  if (mimeLength > 256 || 8 + mimeLength + 4 > b.length) return null
  const mime = ascii(b, 8, mimeLength).toLowerCase()
  let pos = 8 + mimeLength
  pos += 4 + be32(b, pos) // description
  pos += 16 // width, height, colour depth, colour count
  if (pos + 4 > b.length) return null
  const length = be32(b, pos)
  pos += 4
  if (length === 0 || pos + length > b.length) return null
  return { mime, kind, start: pos, length }
}

/** Decode standard base64 (padding optional); null for anything else. */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null
  try {
    const binary = atob(text.length % 4 ? text + '='.repeat(4 - (text.length % 4)) : text)
    return Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}
