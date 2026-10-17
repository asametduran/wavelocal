import { ascii, le16, le32 } from '../source'
import type { ByteSource } from '../source'
import { MAX_PICTURE_BYTES, decodeBase64, parseFlacPicture, parseVorbisComments, tagsFromVorbis } from '../vorbis'
import type { VorbisComments } from '../vorbis'
import { blankFormat } from './types'
import type { ProbeResult } from './types'

/**
 * Ogg Vorbis and Opus probe. The first page holds the identification header (rate, channels), the next pages the
 * comment header (tags and cover art, which may span many pages), and the duration is the granule position of the
 * last page, found by scanning backwards from the end of the file. Nothing in between is read.
 */

const PAGE_HEADER = 27
/** The largest possible page: header, 255 lacing values and 255 segments of 255 bytes. */
const MAX_PAGE = PAGE_HEADER + 255 + 255 * 255
const MAX_COMMENT_BYTES = 16 * 1024 * 1024
const MAX_HEADER_PAGES = 4096
const FRONT_COVER = 3

interface Page {
  /** Absolute offset of the page. */
  offset: number
  granule: number | null
  serial: number
  lacing: number[]
  /** Absolute offsets of the body and of the end of the page. */
  bodyStart: number
  end: number
}

/** Parse a page header at `at` in `b`, whose first byte sits at absolute offset `base`. */
function pageAt(b: Uint8Array, at: number, base: number): Page | null {
  if (at < 0 || at + PAGE_HEADER > b.length || b[at] !== 0x4f || b[at + 1] !== 0x67 || b[at + 2] !== 0x67 || b[at + 3] !== 0x53 || b[at + 4] !== 0) return null
  const count = b[at + 26] ?? 0
  if (at + PAGE_HEADER + count > b.length) return null
  const lacing: number[] = []
  let bodyLength = 0
  for (let i = 0; i < count; i++) {
    const v = b[at + PAGE_HEADER + i] ?? 0
    lacing.push(v)
    bodyLength += v
  }
  const lo = le32(b, at + 6)
  const hi = le32(b, at + 10)
  const unset = lo === 0xffffffff && hi === 0xffffffff
  const bodyStart = base + at + PAGE_HEADER + count
  return { offset: base + at, granule: unset || hi >= 0x200000 ? null : hi * 0x100000000 + lo, serial: le32(b, at + 14), lacing, bodyStart, end: bodyStart + bodyLength }
}

async function readPage(source: ByteSource, at: number): Promise<Page | null> {
  return pageAt(await source.read(at, PAGE_HEADER + 255), 0, at)
}

/** The comment packet (the second packet of the stream) and the offset where its last page ends. */
async function readCommentPacket(source: ByteSource, first: Page): Promise<{ packet: Uint8Array | null; end: number }> {
  let at = first.end
  let parts: Uint8Array[] = []
  let size = 0
  for (let i = 0; i < MAX_HEADER_PAGES; i++) {
    const page = await readPage(source, at)
    if (!page || page.serial !== first.serial) break
    const body = await source.read(page.bodyStart, page.end - page.bodyStart)
    let cursor = 0
    for (const v of page.lacing) {
      parts.push(body.subarray(cursor, cursor + v))
      cursor += v
      size += v
      if (size > MAX_COMMENT_BYTES) return { packet: null, end: page.end }
      if (v < 255) {
        const packet = new Uint8Array(size)
        let o = 0
        for (const part of parts) {
          packet.set(part, o)
          o += part.length
        }
        return { packet, end: page.end }
      }
    }
    at = page.end
  }
  return { packet: null, end: at }
}

/** The granule position of the last page that has one, or null. */
async function lastGranule(source: ByteSource, serial: number, floor: number): Promise<number | null> {
  for (const windows of [1, 3]) {
    const start = Math.max(floor, source.size - windows * MAX_PAGE)
    const b = await source.read(start, source.size - start)
    for (let i = b.length - PAGE_HEADER; i >= 0; i--) {
      if (b[i] !== 0x4f) continue
      const page = pageAt(b, i, start)
      if (!page || page.serial !== serial || page.end - start > b.length) continue // not a real page, another stream, or cut off
      if (page.granule !== null && page.granule > 0) return page.granule
    }
    if (start <= floor) break
  }
  return null
}

const sniffImage = (b: Uint8Array): string | null => (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg' : b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' ? 'image/png' : null)

/** Cover art from METADATA_BLOCK_PICTURE (preferring the front cover), or the older COVERART field. */
function coverFrom(comments: VorbisComments): Blob | null {
  let best: { kind: number; mime: string; bytes: Uint8Array<ArrayBuffer> } | null = null
  for (const [name, value] of comments.fields) {
    if (name !== 'METADATA_BLOCK_PICTURE' || value.length > (MAX_PICTURE_BYTES * 4) / 3 + 1024) continue
    const block = decodeBase64(value)
    const ref = block ? parseFlacPicture(block) : null
    if (!block || !ref || ref.length > MAX_PICTURE_BYTES || !ref.mime.startsWith('image/')) continue
    if (!best || (ref.kind === FRONT_COVER && best.kind !== FRONT_COVER)) best = { kind: ref.kind, mime: ref.mime, bytes: block.slice(ref.start, ref.start + ref.length) }
  }
  if (!best) {
    const legacy = comments.fields.find(([name]) => name === 'COVERART')?.[1]
    const bytes = legacy && legacy.length <= (MAX_PICTURE_BYTES * 4) / 3 + 1024 ? decodeBase64(legacy) : null
    const mime = bytes ? sniffImage(bytes) : null
    if (bytes && mime) best = { kind: FRONT_COVER, mime, bytes }
  }
  return best ? new Blob([best.bytes], { type: best.mime }) : null
}

/** The Vorbis comments of an Ogg Vorbis or Opus file (its second packet), or null. The chapter reader (`chapters/vorbis.ts`) uses it. */
export async function readOggComments(source: ByteSource): Promise<VorbisComments | null> {
  const first = await readPage(source, 0)
  if (!first) return null
  const id = await source.read(first.bodyStart, Math.min(first.end - first.bodyStart, 64))
  const opus = ascii(id, 0, 8) === 'OpusHead'
  if (!opus && !(id[0] === 1 && ascii(id, 1, 6) === 'vorbis')) return null
  const { packet } = await readCommentPacket(source, first)
  return packet ? parseVorbisComments(packet, opus ? 8 : 7) : null
}

export async function probeOgg(source: ByteSource): Promise<ProbeResult | null> {
  const first = await readPage(source, 0)
  if (!first) return null
  const id = await source.read(first.bodyStart, Math.min(first.end - first.bodyStart, 64))
  const opus = ascii(id, 0, 8) === 'OpusHead'
  const vorbis = id[0] === 1 && ascii(id, 1, 6) === 'vorbis'
  if ((!opus && !vorbis) || id.length < (opus ? 19 : 30)) return null

  const channels = opus ? (id[9] ?? 0) : (id[11] ?? 0)
  const preSkip = opus ? le16(id, 10) : 0
  const sampleRate = opus ? 48000 : le32(id, 12)
  const nominal = vorbis && le32(id, 20) < 0x80000000 ? le32(id, 20) : 0
  if (channels < 1 || sampleRate < 1) return null

  const { packet, end: headerEnd } = await readCommentPacket(source, first)
  const comments = packet ? parseVorbisComments(packet, opus ? 8 : 7) : null

  const granule = await lastGranule(source, first.serial, headerEnd)
  const duration = granule === null ? null : opus ? Math.max(0, granule - preSkip) / 48000 : granule / sampleRate
  const audioBytes = Math.max(0, source.size - headerEnd)

  return {
    format: {
      ...blankFormat('ogg', opus ? 'opus' : 'vorbis'),
      sampleRate,
      channels,
      bitrate: nominal > 0 ? nominal : duration ? Math.round((audioBytes * 8) / duration) : 0,
      vbr: opus,
    },
    duration,
    tags: comments ? tagsFromVorbis(comments) : {},
    picture: comments ? coverFrom(comments) : null,
  }
}
