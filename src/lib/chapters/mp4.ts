import { child, children, descend, timing } from '../audio/probe/mp4'
import type { Box } from '../audio/probe/mp4'
import { ascii, be16, be32, be64 } from '../audio/source'
import type { ByteSource } from '../audio/source'
import { paged } from './paged'
import type { RawChapter } from './types'

/**
 * Chapters of an MP4, M4A or M4B, from the two places files keep them: the Nero `chpl` atom (`moov/udta/chpl`, written by
 * ffmpeg and mp4v2, so by most audiobook tools) and the QuickTime chapter track (Apple's audiobooks): the audio track points
 * to a text track with `tref/chap`, and the samples of that track are the titles, timed by its sample table. Only `moov` and
 * the few small text samples are read; the media data is never touched. Everything is untrusted input: every count and size
 * is checked against the box it lives in, and the number of samples is capped.
 */

const MAX_TOP_BOXES = 4096
const MAX_MOOV = 32 * 1024 * 1024
const MAX_SAMPLES = 2000
const MAX_TITLE_BYTES = 1024
/** What a file may start with and still be an MP4 (the same list the probe uses). */
const FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid', 'styp'])

const utf8 = new TextDecoder('utf-8')
const utf16be = new TextDecoder('utf-16be')
const utf16le = new TextDecoder('utf-16le')

/** The bytes of the `moov` box, found by hopping over the boxes in front of it; null when there is none or it is too big. */
async function findMoov(source: ByteSource): Promise<Uint8Array | null> {
  let at = 0
  for (let i = 0; i < MAX_TOP_BOXES && at + 8 <= source.size; i++) {
    const head = await source.read(at, 16)
    if (head.length < 8) return null
    let size = be32(head, 0)
    let header = 8
    const type = ascii(head, 4, 4)
    if (size === 1) {
      if (head.length < 16) return null
      size = be64(head, 8)
      header = 16
    } else if (size === 0) size = source.size - at
    if (size < header) return null
    if (i === 0 && !FIRST_BOXES.has(type)) return null
    if (type === 'moov') {
      const length = Math.min(size, source.size - at)
      return length > MAX_MOOV ? null : source.read(at, length)
    }
    at += size
  }
  return null
}

/** `moov/udta/chpl`: a version, [4 reserved bytes in version 1], a count, then for each chapter a start in 100 ns units and a length-prefixed title. */
function readChpl(b: Uint8Array, root: Box): RawChapter[] {
  const chpl = descend(b, root, 'udta', 'chpl')
  if (!chpl) return []
  let at = chpl.payload
  const version = b[at] ?? 0
  at += version === 1 ? 8 : 4
  const count = b[at++] ?? 0
  const out: RawChapter[] = []
  for (let i = 0; i < count && at + 9 <= chpl.end; i++) {
    const start = be64(b, at) / 10_000_000
    const length = b[at + 8] ?? 0
    at += 9
    out.push({ start, title: utf8.decode(b.subarray(at, Math.min(at + length, chpl.end))) })
    at += length
  }
  return out
}

const trackIdOf = (b: Uint8Array, trak: Box): number => {
  const tkhd = child(b, trak, 'tkhd')
  return tkhd ? be32(b, tkhd.payload + 4 + ((b[tkhd.payload] ?? 0) === 1 ? 16 : 8)) : 0
}

/** The entries of a sample-table box that fit in it: `count` as written, but never more than the box can hold. */
const entriesIn = (b: Uint8Array, box: Box, headerBytes: number, entryBytes: number): number =>
  Math.max(0, Math.min(be32(b, box.payload + 4), Math.floor((box.end - box.payload - headerBytes) / entryBytes)))

/** Where each sample of a track is in the file and how big it is, from `stsc`, `stsz` and `stco`/`co64`. */
function sampleLocations(b: Uint8Array, stbl: Box): { offset: number; size: number }[] {
  const stsz = child(b, stbl, 'stsz')
  const stsc = child(b, stbl, 'stsc')
  const stco = child(b, stbl, 'stco')
  const co64 = child(b, stbl, 'co64')
  const chunks = stco ?? co64
  if (!stsz || !stsc || !chunks) return []
  const constant = be32(b, stsz.payload + 4)
  const sampleCount = Math.min(be32(b, stsz.payload + 8), MAX_SAMPLES, constant > 0 ? MAX_SAMPLES : Math.floor((stsz.end - stsz.payload - 12) / 4))
  const runs = entriesIn(b, stsc, 8, 12)
  const chunkCount = entriesIn(b, chunks, 8, chunks === stco ? 4 : 8)

  const out: { offset: number; size: number }[] = []
  let run = 0
  for (let chunk = 1; chunk <= chunkCount && out.length < sampleCount; chunk++) {
    while (run + 1 < runs && be32(b, stsc.payload + 8 + (run + 1) * 12) <= chunk) run++
    const perChunk = be32(b, stsc.payload + 8 + run * 12 + 4)
    let offset = chunks === stco ? be32(b, chunks.payload + 8 + (chunk - 1) * 4) : be64(b, chunks.payload + 8 + (chunk - 1) * 8)
    for (let s = 0; s < perChunk && out.length < sampleCount; s++) {
      const size = constant > 0 ? constant : be32(b, stsz.payload + 12 + out.length * 4)
      out.push({ offset, size })
      offset += size
    }
  }
  return out
}

/** The start of each sample, in ticks of the track's time scale, from the time-to-sample table (`stts`). */
function sampleStarts(b: Uint8Array, stts: Box, limit: number): number[] {
  const out: number[] = []
  let time = 0
  const entries = entriesIn(b, stts, 8, 8)
  for (let i = 0; i < entries && out.length < limit; i++) {
    const count = be32(b, stts.payload + 8 + i * 8)
    const delta = be32(b, stts.payload + 8 + i * 8 + 4)
    for (let k = 0; k < count && out.length < limit; k++) {
      out.push(time)
      time += delta
    }
  }
  return out
}

/** A text sample: a 16-bit length, then the text, in UTF-8 or (with a byte order mark) UTF-16. */
function sampleText(sample: Uint8Array): string {
  if (sample.length < 2) return ''
  const body = sample.subarray(2, 2 + Math.min(be16(sample, 0), sample.length - 2, MAX_TITLE_BYTES))
  if (body[0] === 0xfe && body[1] === 0xff) return utf16be.decode(body.subarray(2))
  if (body[0] === 0xff && body[1] === 0xfe) return utf16le.decode(body.subarray(2))
  return utf8.decode(body)
}

async function readTextTrack(source: ByteSource, b: Uint8Array, root: Box): Promise<RawChapter[]> {
  // the audio track says which track holds its chapters
  let id = 0
  for (const trak of children(b, root.payload, root.end)) {
    if (trak.type !== 'trak' || ascii(b, (descend(b, trak, 'mdia', 'hdlr')?.payload ?? 0) + 8, 4) !== 'soun') continue
    const chap = descend(b, trak, 'tref', 'chap')
    if (chap && chap.payload + 4 <= chap.end) {
      id = be32(b, chap.payload)
      break
    }
  }
  if (!id) return []

  for (const trak of children(b, root.payload, root.end)) {
    if (trak.type !== 'trak' || trackIdOf(b, trak) !== id) continue
    const handler = ascii(b, (descend(b, trak, 'mdia', 'hdlr')?.payload ?? 0) + 8, 4)
    if (handler !== 'text' && handler !== 'sbtl') continue // a track of sound has no titles in it
    const mdhd = descend(b, trak, 'mdia', 'mdhd')
    const stbl = descend(b, trak, 'mdia', 'minf', 'stbl')
    const stts = stbl && child(b, stbl, 'stts')
    const timescale = mdhd ? timing(b, mdhd).timescale : 0
    if (!stbl || !stts || !timescale) return []
    const where = sampleLocations(b, stbl)
    const starts = sampleStarts(b, stts, where.length)
    const read = paged((offset, length) => source.read(offset, length), source.size)
    const out: RawChapter[] = []
    for (const [i, at] of where.entries()) {
      const start = starts[i]
      if (start === undefined) break
      out.push({ start: start / timescale, title: sampleText(await read(at.offset, Math.min(at.size, MAX_TITLE_BYTES + 2))) })
    }
    return out
  }
  return []
}

/** The chapters of an MP4 file as it gives them (see `normalizeChapters`); none if it has no chapters or is not an MP4. */
export async function readMp4Chapters(source: ByteSource): Promise<RawChapter[]> {
  const moov = await findMoov(source)
  if (!moov) return []
  const root: Box = { type: 'moov', payload: be32(moov, 0) === 1 ? 16 : 8, end: moov.length }
  const nero = readChpl(moov, root)
  return nero.length > 0 ? nero : readTextTrack(source, moov, root)
}
