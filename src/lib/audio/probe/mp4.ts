import { ascii, be16, be32, be64 } from '../source'
import type { ByteSource } from '../source'
import { blankFormat } from './types'
import type { AudioCodec, ProbeResult } from './types'

/**
 * MP4 / M4A / MOV probe. The file is walked box by box reading only box headers (so a late `moov` after a huge `mdat`
 * costs the same as an early one), then `moov` is read whole to find the movie and audio-track durations and the
 * sample description (AAC, Apple Lossless, MP3, Opus, FLAC). Tags and artwork are left to jsmediatags.
 */

const MAX_TOP_BOXES = 4096
const MAX_MOOV = 32 * 1024 * 1024
/** Box types a media file may start with (everything else is not an MP4 as far as this probe is concerned). */
const FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid', 'styp'])

interface Box {
  type: string
  /** Offsets within the buffer being walked. */
  payload: number
  end: number
}

function* children(b: Uint8Array, start: number, end: number): Generator<Box> {
  let at = start
  while (at + 8 <= end) {
    let size = be32(b, at)
    let header = 8
    if (size === 1) {
      size = be64(b, at + 8)
      header = 16
    } else if (size === 0) size = end - at
    if (size < header) return
    yield { type: ascii(b, at + 4, 4), payload: at + header, end: Math.min(end, at + size) }
    at += size
  }
}

const childIn = (b: Uint8Array, start: number, end: number, type: string): Box | undefined => {
  for (const c of children(b, start, end)) if (c.type === type) return c
  return undefined
}

const child = (b: Uint8Array, parent: Box, type: string): Box | undefined => childIn(b, parent.payload, parent.end, type)

const descend = (b: Uint8Array, parent: Box | undefined, ...path: string[]): Box | undefined => {
  let box = parent
  for (const type of path) {
    if (!box) return undefined
    box = child(b, box, type)
  }
  return box
}

/** Time scale and duration (seconds, or null when unset) of an `mvhd` or `mdhd` box. */
function timing(b: Uint8Array, box: Box): { timescale: number; duration: number | null } {
  const v1 = (b[box.payload] ?? 0) === 1
  const timescale = be32(b, box.payload + (v1 ? 20 : 12))
  const raw = v1 ? be64(b, box.payload + 24) : be32(b, box.payload + 16)
  const unset = raw === 0 || (v1 ? raw >= 2 ** 63 : raw === 0xffffffff)
  return { timescale, duration: unset || !timescale ? null : raw / timescale }
}

function readEsds(b: Uint8Array, box: Box): { objectType: number; avgBitrate: number } | null {
  let at = box.payload + 4
  const length = (): void => {
    for (let i = 0; i < 4; i++) if (!((b[at++] ?? 0) & 0x80)) break
  }
  if (b[at] !== 0x03) return null
  at++
  length()
  at += 2 // ES_ID
  const flags = b[at++] ?? 0
  if (flags & 0x80) at += 2
  if (flags & 0x40) at += 1 + (b[at] ?? 0)
  if (flags & 0x20) at += 2
  if (b[at] !== 0x04) return null
  at++
  length()
  return at + 13 <= box.end ? { objectType: b[at] ?? 0, avgBitrate: be32(b, at + 9) } : null
}

interface Track {
  codec: AudioCodec
  sampleRate: number
  channels: number
  bitDepth: number
  /** What the codec box declares (0 when it does not). Encoders often write a placeholder here. */
  bitrate: number
  /** The bytes of the track's samples, from the sample size table, or 0 when there is none. */
  bytes: number
  lossless: boolean
  duration: number | null
}

/** Total size of the track's samples (`stsz`), which with the duration gives the true average bitrate. */
function sampleBytes(b: Uint8Array, stsz: Box | undefined): number {
  if (!stsz || stsz.payload + 12 > stsz.end) return 0
  const size = be32(b, stsz.payload + 4)
  const count = be32(b, stsz.payload + 8)
  if (size > 0) return size * count
  let total = 0
  const entries = Math.min(count, Math.floor((stsz.end - stsz.payload - 12) / 4))
  for (let i = 0, at = stsz.payload + 12; i < entries; i++, at += 4) total += be32(b, at)
  return total
}

/**
 * The track header's duration in seconds. It is in movie time-scale units and already reflects the edit list, so it is
 * the playable length: the media itself is longer by the priming samples an AAC encoder adds (1024, about 23 ms).
 */
function trackDuration(b: Uint8Array, trak: Box, movieTimescale: number): number | null {
  const tkhd = child(b, trak, 'tkhd')
  if (!tkhd || !movieTimescale) return null
  const v1 = (b[tkhd.payload] ?? 0) === 1
  const raw = v1 ? be64(b, tkhd.payload + 28) : be32(b, tkhd.payload + 20)
  return raw === 0 || (v1 ? raw >= 2 ** 63 : raw === 0xffffffff) ? null : raw / movieTimescale
}

function readAudioTrack(b: Uint8Array, trak: Box, movieTimescale: number): Track | null {
  const mdia = child(b, trak, 'mdia')
  const hdlr = descend(b, mdia, 'hdlr')
  if (!mdia || !hdlr || ascii(b, hdlr.payload + 8, 4) !== 'soun') return null

  const mdhd = child(b, mdia, 'mdhd')
  const media = mdhd ? timing(b, mdhd) : { timescale: 0, duration: null }
  const out: Track = { codec: 'unknown', sampleRate: 0, channels: 0, bitDepth: 0, bitrate: 0, bytes: 0, lossless: false, duration: trackDuration(b, trak, movieTimescale) ?? media.duration }

  const stbl = descend(b, mdia, 'minf', 'stbl')
  out.bytes = sampleBytes(b, stbl && child(b, stbl, 'stsz'))
  const stsd = stbl && child(b, stbl, 'stsd')
  if (!stsd || stsd.payload + 8 + 36 > stsd.end) {
    out.sampleRate = media.timescale
    return out
  }
  const entry = stsd.payload + 8
  const entryEnd = Math.min(stsd.end, entry + be32(b, entry))
  const type = ascii(b, entry + 4, 4)
  const soundVersion = be16(b, entry + 16)
  out.channels = be16(b, entry + 24)
  out.bitDepth = be16(b, entry + 26)
  out.sampleRate = be32(b, entry + 32) >>> 16
  const kids = entry + (soundVersion === 1 ? 52 : soundVersion === 2 ? 72 : 36)

  if (type === 'mp4a') {
    const box = childIn(b, kids, entryEnd, 'esds')
    const es = box ? readEsds(b, box) : null
    out.codec = es && (es.objectType === 0x69 || es.objectType === 0x6b) ? 'mp3' : 'aac'
    out.bitrate = es?.avgBitrate ?? 0
    out.bitDepth = 0 // the 16 in a lossy entry is not a property of the stream
  } else if (type === '.mp3') {
    out.codec = 'mp3'
    out.bitDepth = 0
  } else if (type === 'alac') {
    out.codec = 'alac'
    out.lossless = true
    const cookie = childIn(b, kids, entryEnd, 'alac')
    if (cookie && cookie.payload + 28 <= cookie.end) {
      const p = cookie.payload + 4 // after the version and flags
      out.bitDepth = b[p + 5] ?? out.bitDepth
      out.channels = b[p + 9] ?? out.channels
      // the cookie's average bitrate is the uncompressed rate in practice, so the bitrate comes from the media data
      out.sampleRate = be32(b, p + 20) || out.sampleRate
    }
  } else if (type === 'fLaC') {
    out.codec = 'flac'
    out.lossless = true
  } else if (type === 'Opus') {
    out.codec = 'opus'
    out.sampleRate = 48000
    out.bitDepth = 0
  } else {
    out.bitDepth = 0
  }
  if (!out.sampleRate) out.sampleRate = media.timescale
  return out
}

export async function probeMp4(source: ByteSource): Promise<ProbeResult | null> {
  let at = 0
  let moov: Uint8Array | null = null
  let mdat = 0
  for (let i = 0; i < MAX_TOP_BOXES && at + 8 <= source.size; i++) {
    const head = await source.read(at, 16)
    if (head.length < 8) break
    let size = be32(head, 0)
    let header = 8
    const type = ascii(head, 4, 4)
    if (size === 1) {
      if (head.length < 16) break
      size = be64(head, 8)
      header = 16
    } else if (size === 0) size = source.size - at
    if (size < header) break
    if (i === 0 && !FIRST_BOXES.has(type)) return null
    if (type === 'moov' && !moov) {
      const length = Math.min(size, source.size - at)
      if (length > MAX_MOOV) return null
      moov = await source.read(at, length)
    } else if (type === 'mdat') mdat += size - header
    at += size
  }
  if (!moov) return null

  const root: Box = { type: 'moov', payload: be32(moov, 0) === 1 ? 16 : 8, end: moov.length }
  const mvhd = child(moov, root, 'mvhd')
  const movie = mvhd ? timing(moov, mvhd) : { timescale: 0, duration: null }

  let audio: Track | null = null
  for (const c of children(moov, root.payload, root.end)) {
    if (c.type !== 'trak') continue
    audio = readAudioTrack(moov, c, movie.timescale)
    if (audio) break
  }

  const duration = audio?.duration ?? movie.duration
  if (!audio && duration === null) return null
  const format = { ...blankFormat('mp4', audio?.codec ?? 'unknown') }
  if (audio) {
    format.sampleRate = audio.sampleRate
    format.channels = audio.channels
    format.bitDepth = audio.bitDepth
    format.lossless = audio.lossless
    // the samples themselves are the truth; then what the codec box says; then everything in the media data box
    const measured = (bytes: number): number => (duration && bytes ? Math.round((bytes * 8) / duration) : 0)
    format.bitrate = measured(audio.bytes) || audio.bitrate || measured(mdat)
  }
  return { format, duration, tags: {}, picture: null }
}
